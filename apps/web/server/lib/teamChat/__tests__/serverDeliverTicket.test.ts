// serverDeliver's PRODUCTION adapter path for a board task run: what the run is
// told about its task, and which session it continues. The driver factory and
// the OpenClaw adapter are mocked (file-global vi.mocks, hence this file) to
// capture the run context and the start options; capabilities come from the
// real adapters, so home resolution matches production.
//
// Before: every engine run started with `taskId: null`, a Tasks URL that named
// no task, no ticket block, and a fresh session on every retry.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  addComment,
  agents,
  claimTask,
  createExecutionProcess,
  createTask,
  enqueueInbox,
  getSetting,
  getTask,
  tasks,
  teams,
  updateStatus,
  updateTaskFields,
  type ClawbooDb,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { createNudgeQueue, type TurnOrigin } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { getDb, resetDb } from '../../db'
import { homeDispatchMutex } from '../../executorRunner'
import { runtimeIdentityHomePath } from '../../runtimes/identityHome'
import type { RuntimeRunContext } from '../../runtimes/types'
import { parseTaskSessionPointer, taskSessionSettingKey } from '../nativeTeamSession'
import { createServerDeliver } from '../serverDeliver'
import { clearTaskSessionPointers, ticketHashOf } from '../taskSessionPointers'

interface Captured {
  runtime: string
  ctx: RuntimeRunContext | null
  task: TaskHandle
  opts: StartOpts
}
const captured = vi.hoisted(() => [] as Captured[])
/** How each next run ends, and the session id its codec reports. */
const script = vi.hoisted(() => ({
  /** A `done` reason, or 'stream-dies' for a stream that throws before any terminal. */
  reason: 'success' as string,
  sessionIds: [] as string[],
  /** Thrown by `start`, as an adapter does when it cannot open the session. */
  startError: null as string | null,
  /** Run just before the terminal, as a person acting mid-run would. */
  beforeTerminal: null as (() => void) | null,
}))

/** The session id the next RUN reports. Taken when a run's adapter is built,
 *  never by serverDeliver's capability probe, which builds one too. */
const nextSessionId = (id: string): string => script.sessionIds.shift() ?? `${id}-session`

function scriptedAdapter(
  id: string,
  caps: Capabilities,
  ctx: RuntimeRunContext | null,
  sessionId: string,
): RuntimeAdapter {
  return {
    id: id as RuntimeAdapter['id'],
    participantKind: 'agent',
    capabilities: () => caps,
    health: async () => ({ ok: true }),
    start: async (task, opts): Promise<RunHandle> => {
      captured.push({ runtime: id, ctx, task, opts })
      if (script.startError) throw new Error(script.startError)
      return { adapterId: id, sessionKey: opts.sessionKey, runId: null }
    },
    events: async function* (run: RunHandle): AsyncIterable<RuntimeEvent> {
      const at = { runId: run.sessionKey, sessionId: run.sessionKey, ts: 1 }
      script.beforeTerminal?.()
      if (script.reason === 'stream-dies') throw new Error('stream lost')
      // Every real adapter ends a failed run this way: a fatal error, then `done`.
      if (script.reason === 'error')
        yield { ...at, seq: 1, kind: 'error', code: null, message: 'boom', fatal: true }
      yield { ...at, seq: 2, kind: 'done', reason: script.reason, summary: 'ok' } as RuntimeEvent
    },
    abort: async () => {},
    setModel: async () => {},
    writeContext: async () => {},
    sessionCodec: {
      serialize: async () => JSON.stringify({ sessionId }),
      restore: async (): Promise<RunHandle> => ({ adapterId: id, sessionKey: 's', runId: null }),
    },
  }
}

vi.mock('../../runtimes', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runtimes')>()
  return {
    ...real,
    adapterFactoryFor: (id: Parameters<typeof real.adapterFactoryFor>[0]) => {
      const caps = real.adapterFactoryFor(id)({}).capabilities()
      // The empty-ctx call is serverDeliver's capability probe, not the run.
      return (ctx: RuntimeRunContext): RuntimeAdapter =>
        ctx.memoryScope
          ? scriptedAdapter(id, caps, ctx, nextSessionId(id))
          : scriptedAdapter(id, caps, null, 'probe')
    },
  }
})

vi.mock('../../runtimes/serverAdapter', () => ({
  buildOpenClawServerAdapter: () =>
    scriptedAdapter(
      'openclaw',
      {
        streaming: true,
        mcp: false,
        worktrees: false,
        resume: false,
        toolApproval: false,
        models: [],
        runtimeClass: 'connected-substrate',
      },
      null,
      nextSessionId('openclaw'),
    ),
}))

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick()
}

const RESUMABLE = ['claude-code', 'codex', 'hermes', 'clawboo-native'] as const

describe('serverDeliver: a board task run is bound to its task', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb
  /** session key -> the task the engine maps it to, as the engine would. */
  const sessionTask = new Map<string, string>()
  const sessionExec = new Map<string, string>()

  /** Runs whose drain has ended: a terminal event, or a stream closed without one. */
  let ended = 0

  beforeEach(async () => {
    captured.length = 0
    ended = 0
    script.reason = 'success'
    script.sessionIds = []
    script.startError = null
    script.beforeTerminal = null
    sessionTask.clear()
    sessionExec.clear()
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-deliver-ticket-'))
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'Team T', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Ada',
        gatewayId: 'lead',
        runtime: 'claude-code',
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  function seedAgent(id: string, runtime: string): void {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name: `Agent ${id}`,
        gatewayId: id,
        runtime,
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  function deliver(nudge = createNudgeQueue()) {
    return createServerDeliver({
      db,
      teamId: 'T',
      mcpBaseUrl: 'http://127.0.0.1:1',
      nudge,
      abortMap: new Map(),
      onEvent: async (_sk, ev) => {
        if (ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)) ended++
      },
      onSessionClosed: async () => {
        ended++
      },
      taskForSession: (sk) => sessionTask.get(sk) ?? null,
      execForSession: (sk) => sessionExec.get(sk) ?? null,
      stopGen: () => 0,
      leaderAgentId: () => 'lead',
      persistTurn: () => true,
      persistMeta: () => true,
    })
  }

  /** Claim `taskId` for `agentId` and open its run, then deliver it the way the
   *  engine does: the session mapped to the task, the brief as the message.
   *  Returns once the run has ended, or once its start has failed. */
  async function runTask(
    agentId: string,
    taskId: string,
    brief: string,
    { failsToStart = false } = {},
  ): Promise<Captured> {
    const sk = `agent:${agentId}:team:T`
    const exec = createExecutionProcess(db, { taskId, executorType: 'openclaw' })
    sessionTask.set(sk, taskId)
    sessionExec.set(sk, exec.id)
    const origin: TurnOrigin = { kind: 'delegation', fromAgentId: 'lead' }
    const before = captured.length
    const endedBefore = ended
    const delivery = deliver()(sk, agentId, brief, origin)
    if (failsToStart) await expect(delivery).rejects.toThrow()
    else await delivery
    await vi.waitFor(() => expect(captured.length).toBe(before + 1), { timeout: 5000 })
    if (!failsToStart) await vi.waitFor(() => expect(ended).toBe(endedBefore + 1))
    await settle()
    return captured[captured.length - 1]!
  }

  function claimedTask(title: string, agentId: string): string {
    const t = createTask(db, { title, description: `Details for ${title}.`, teamId: 'T' })
    expect(claimTask(db, t.id, agentId).ok).toBe(true)
    return t.id
  }

  for (const runtime of [...RESUMABLE, 'openclaw'] as const) {
    it(`a ${runtime} task run carries the task id and the ticket block, after the stable preamble`, async () => {
      seedAgent('a1', runtime)
      const taskId = claimedTask('Write the parser', 'a1')
      enqueueInbox(db, { agentId: 'a1', teamId: 'T', kind: 'alert', taskId, body: 'Heads up.' })
      const run = await runTask('a1', taskId, 'Write the parser\n\nDetails for Write the parser.')

      expect(run.task.taskId).toBe(taskId)
      // The brief stays the message, the agent's instruction.
      expect(run.opts.message).toBe('Write the parser\n\nDetails for Write the parser.')
      const context = run.opts.context ?? ''
      expect(context).toContain(`Task id: ${taskId}.`)
      // Stable team preamble, then the ticket block, then the envelope.
      const roster = context.indexOf('Your teammates')
      const open = context.indexOf('[Your task on the board]')
      const close = context.indexOf('[End your task]')
      const addressed = context.indexOf('[Addressed to you')
      expect(roster).toBeGreaterThan(-1)
      expect(roster).toBeLessThan(open)
      expect(open).toBeLessThan(close)
      expect(close).toBeLessThan(addressed)
      if (runtime === 'openclaw') {
        // No per-run Tasks scope to bind: the id is in the prompt only.
        expect(context).toContain('Pass it as taskId')
        expect(run.ctx).toBeNull()
      } else {
        expect(run.ctx?.memoryScope?.boundTaskId).toBe(taskId)
        // Not the provenance stamp: memory promotion is unchanged.
        expect(run.ctx?.memoryScope?.taskId).toBeUndefined()
      }
    })
  }

  it('keeps the stable preamble byte-identical from one task to the next', async () => {
    seedAgent('a1', 'codex')
    const first = await runTask('a1', claimedTask('First', 'a1'), 'First')
    const second = await runTask('a1', claimedTask('Second', 'a1'), 'Second')
    const prefix = (c: Captured) => {
      const ctx = c.opts.context ?? ''
      return ctx.slice(0, ctx.indexOf('[Your task on the board]'))
    }
    expect(prefix(first).length).toBeGreaterThan(0)
    expect(prefix(second)).toBe(prefix(first))
  })

  for (const runtime of RESUMABLE) {
    it(`a second ${runtime} run on the same task resumes the same session; another task, another agent or a cleared task does not`, async () => {
      seedAgent('a1', runtime)
      seedAgent('a2', runtime)
      const taskId = claimedTask('Long task', 'a1')
      script.sessionIds = [`${runtime}-sid-1`]

      const first = await runTask('a1', taskId, 'Long task')
      expect(first.ctx?.resume ?? null).toBeNull()
      // Written on the run's terminal, before the next run reads it.
      await vi.waitFor(() =>
        expect(getSetting(db, taskSessionSettingKey('a1', 'T', taskId))).toContain(
          `${runtime}-sid-1`,
        ),
      )

      const second = await runTask('a1', taskId, 'Long task')
      expect(second.ctx?.resume).toBe(`${runtime}-sid-1`)
      expect(second.opts.context).toContain('You are continuing this task in the same session')

      // Another task by the same agent starts its own session.
      const other = await runTask('a1', claimedTask('Other task', 'a1'), 'Other task')
      expect(other.ctx?.resume ?? null).toBeNull()

      // Another agent on the same task starts fresh: the pointer is per agent.
      const handedOver = await runTask('a2', taskId, 'Long task')
      expect(handedOver.ctx?.resume ?? null).toBeNull()

      // Reassigned (the Assign route clears the task's pointers): fresh again.
      clearTaskSessionPointers(db, taskId)
      const reassigned = await runTask('a1', taskId, 'Long task')
      expect(reassigned.ctx?.resume ?? null).toBeNull()
    })
  }

  it('a failed resumed run clears the pointer; one stopped part way or out of turns keeps it', async () => {
    seedAgent('a1', 'codex')
    const taskId = claimedTask('Fragile', 'a1')
    const key = taskSessionSettingKey('a1', 'T', taskId)
    script.sessionIds = ['sid-1', 'sid-2', 'sid-3', 'sid-4']
    await runTask('a1', taskId, 'Fragile')
    expect(getSetting(db, key)).toContain('sid-1')

    script.reason = 'aborted'
    expect((await runTask('a1', taskId, 'Fragile')).ctx?.resume).toBe('sid-1')
    expect(getSetting(db, key)).toContain('sid-2')

    script.reason = 'max_turns'
    expect((await runTask('a1', taskId, 'Fragile')).ctx?.resume).toBe('sid-2')
    expect(getSetting(db, key)).toContain('sid-3')

    // A fatal error, then `done`: the loop stops at the error, which must clear.
    script.reason = 'error'
    expect((await runTask('a1', taskId, 'Fragile')).ctx?.resume).toBe('sid-3')
    expect(getSetting(db, key)).toBe('')

    script.reason = 'success'
    expect((await runTask('a1', taskId, 'Fragile')).ctx?.resume ?? null).toBeNull()
  })

  it('a resumed run that cannot start, or whose stream dies, clears the pointer', async () => {
    seedAgent('a1', 'claude-code')
    const taskId = claimedTask('Gone session', 'a1')
    const key = taskSessionSettingKey('a1', 'T', taskId)
    // The refused run's adapter is built before its start throws, so it takes one.
    script.sessionIds = ['sid-1', 'sid-refused', 'sid-2']
    await runTask('a1', taskId, 'Gone session')
    expect(getSetting(db, key)).toContain('sid-1')

    script.startError = 'No conversation found with session ID: sid-1'
    const refused = await runTask('a1', taskId, 'Gone session', { failsToStart: true })
    expect(refused.ctx?.resume).toBe('sid-1')
    expect(getSetting(db, key)).toBe('')

    script.startError = null
    await runTask('a1', taskId, 'Gone session')
    expect(getSetting(db, key)).toContain('sid-2')
    script.reason = 'stream-dies'
    expect((await runTask('a1', taskId, 'Gone session')).ctx?.resume).toBe('sid-2')
    expect(getSetting(db, key)).toBe('')
  })

  it('a run on a task cancelled while it ran writes no pointer back', async () => {
    seedAgent('a1', 'codex')
    const taskId = claimedTask('Short-lived', 'a1')
    const key = taskSessionSettingKey('a1', 'T', taskId)
    script.sessionIds = ['sid-1', 'sid-2']
    await runTask('a1', taskId, 'Short-lived')
    expect(getSetting(db, key)).toContain('sid-1')

    // A person cancels it mid-run: its pointers are cleared then (the lifecycle
    // subscriber's job, done by hand here), and the stopped run ends `aborted`.
    script.reason = 'aborted'
    script.beforeTerminal = () => {
      expect(updateStatus(db, taskId, 'cancelled').ok).toBe(true)
      clearTaskSessionPointers(db, taskId)
    }
    await runTask('a1', taskId, 'Short-lived')
    expect(getSetting(db, key)).toBeNull()
  })

  it('records the hash of the brief it was sent, not of an edit made while it waited', async () => {
    seedAgent('a1', 'codex')
    const taskId = claimedTask('Edited task', 'a1')
    const sk = 'agent:a1:team:T'
    const exec = createExecutionProcess(db, { taskId, executorType: 'openclaw' })
    sessionTask.set(sk, taskId)
    sessionExec.set(sk, exec.id)
    const briefHash = ticketHashOf(getTask(db, taskId)!)

    // The agent is busy, so the delivery waits in the queue, and a person edits
    // the description meanwhile. The brief was written before the edit.
    const nudge = createNudgeQueue()
    nudge.markBusy(sk)
    await deliver(nudge)(sk, 'a1', 'Edited task\n\nDetails for Edited task.', {
      kind: 'delegation',
      fromAgentId: 'lead',
    })
    updateTaskFields(db, taskId, { description: 'Different details.' })
    nudge.markIdle(sk)
    await vi.waitFor(() => expect(ended).toBe(1))

    const pointer = parseTaskSessionPointer(
      getSetting(db, taskSessionSettingKey('a1', 'T', taskId)),
    )
    expect(pointer?.ticketHash).toBe(briefHash)
    // When the run ended, so a later run can tell this session's own comments
    // from ones the agent wrote elsewhere afterwards.
    expect(pointer?.endedAt).toBeGreaterThanOrEqual(pointer!.seenAt)
    // And the run itself was told its brief is older than the task.
    expect(captured[captured.length - 1]!.opts.context).toMatch(
      /edited after the brief at the end of this message was written/,
    )
  })

  it('builds the task block once it holds the agent’s lock, not while it waits', async () => {
    seedAgent('a1', 'codex')
    const taskId = claimedTask('Waiting task', 'a1')
    const sk = 'agent:a1:team:T'
    const exec = createExecutionProcess(db, { taskId, executorType: 'openclaw' })
    sessionTask.set(sk, taskId)
    sessionExec.set(sk, exec.id)
    // Another of the agent's runs (the task runner, a routine) holds its home.
    let release!: () => void
    const held = homeDispatchMutex.run(
      runtimeIdentityHomePath('codex', 'a1'),
      () => new Promise<void>((resolve) => (release = resolve)),
    )

    const delivery = deliver()(sk, 'a1', 'Waiting task', {
      kind: 'delegation',
      fromAgentId: 'lead',
    })
    await settle()
    expect(captured).toHaveLength(0)
    addComment(db, taskId, 'written while the run waited', 'user')
    release()
    await held
    await delivery
    await vi.waitFor(() => expect(ended).toBe(1))
    expect(captured[0]!.opts.context).toContain('written while the run waited')
  })

  it('a run stopped by a reassignment writes no pointer back for its agent', async () => {
    seedAgent('a1', 'codex')
    seedAgent('a2', 'codex')
    const taskId = claimedTask('Handed over', 'a1')
    const key = taskSessionSettingKey('a1', 'T', taskId)
    const bindTo = (agentId: string, nonce: string) =>
      db
        .update(tasks)
        .set({ sourceDelegationId: encodeHumanAssignment(agentId, nonce) })
        .where(eq(tasks.id, taskId))
        .run()
    script.sessionIds = ['sid-1', 'sid-2', 'sid-3']
    bindTo('a1', 'n0')
    await runTask('a1', taskId, 'Handed over')
    expect(getSetting(db, key)).toContain('sid-1')

    // Stopped while still the agent's task: the session is kept.
    script.reason = 'aborted'
    await runTask('a1', taskId, 'Handed over')
    expect(getSetting(db, key)).toContain('sid-2')

    // Given to a2 mid-run: the Assign route rebinds the task and clears its
    // pointers, and the stopped run ends `aborted` only after that.
    script.beforeTerminal = () => {
      bindTo('a2', 'n1')
      clearTaskSessionPointers(db, taskId)
    }
    await runTask('a1', taskId, 'Handed over')
    expect(getSetting(db, key)).toBeNull()
  })

  it('never writes a task pointer for OpenClaw', async () => {
    seedAgent('a1', 'openclaw')
    const taskId = claimedTask('Claw task', 'a1')
    await runTask('a1', taskId, 'Claw task')
    expect(getSetting(db, taskSessionSettingKey('a1', 'T', taskId))).toBeNull()
  })
})
