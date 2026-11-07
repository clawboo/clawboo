// A person's comment on a task reaches the run working on it, mid-run, and the
// steer changes nothing about how the team engine sees that run. Wires the REAL
// engine (createBoardOrchestrator) + the REAL run primitive (createServerDeliver)
// + the REAL board over sqlite, exactly as teamOrchestrator's buildInstance does,
// with scripted adapters injected through `makeAdapterForAgent`.
//
// The worker steers by interrupt-and-resume (the Hermes shape): its driver stops
// the process and resumes the same session, so its event stream carries a second
// `init` and NO terminal for the stopped part. That is the case the steering design
// has to get right: an abort that surfaced would hit the engine's failure path
// (block the task, fail the execution, reflect a failure to the lead). It must not.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  getComments,
  listExecutions,
  listTasks,
  listUndeliveredInbox,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  SteerResult,
  TaskHandle,
} from '@clawboo/executor'
import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  createBoardOrchestrator,
  createNudgeQueue,
  HUMAN_TURN,
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'

import { getDb, getDbPath, resetDb } from '../../db'
import { hasRunForTask, resetRunSteers, registerRunSteer } from '../../runSteers'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import { forwardPersonCommentToRun, STEER_BATCH_MS } from '../taskSteer'
import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const skFor = (id: string): string => buildTeamSessionKey(id, TEAM)!

const CAPS: Capabilities = {
  streaming: false,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const ev = (sk: string, seq: number, e: Record<string, unknown>): RuntimeEvent =>
  ({ ...e, runId: sk, sessionId: sk, ts: seq, seq }) as RuntimeEvent

/** The lead: one turn that delegates, then a synthesis turn per reflection. */
class LeadAdapter implements RuntimeAdapter {
  readonly id = 'lead-rt'
  readonly participantKind = 'agent' as const
  readonly messages: string[] = []
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.messages.push(opts.message)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const first = this.messages.length === 1
    const sk = run.sessionKey
    return (async function* () {
      yield ev(sk, 1, {
        kind: 'done',
        reason: 'success',
        summary: first
          ? '<delegate to="@Writer">write the launch post</delegate>'
          : 'Synthesis done.',
      })
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

/** The worker: works until steered, then "stops and resumes" inside the run. */
class SteeredWorkerAdapter implements RuntimeAdapter {
  readonly id = 'worker-rt'
  readonly participantKind = 'agent' as const
  readonly steers: string[] = []
  aborted = 0
  private readonly steered = deferred()
  capabilities(): Capabilities {
    return { ...CAPS, steering: 'interrupt-resume' }
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const sk = run.sessionKey
    const steered = this.steered.promise
    const steers = this.steers
    return (async function* () {
      yield ev(sk, 1, { kind: 'status', phase: 'init' })
      yield ev(sk, 2, {
        kind: 'tool-call',
        toolCallId: 't1',
        name: 'shell',
        input: {},
        partial: false,
      })
      await steered
      // The stopped process left no terminal; the resumed one starts afresh.
      yield ev(sk, 3, { kind: 'status', phase: 'init' })
      yield ev(sk, 4, { kind: 'text-delta', text: `Short post. (${steers.length} note)` })
      yield ev(sk, 5, { kind: 'done', reason: 'success', summary: 'Short post.' })
    })()
  }
  async steer(_run: RunHandle, text: string): Promise<SteerResult> {
    this.steers.push(text)
    this.steered.resolve()
    return { delivered: true, mode: 'interrupt-resume' }
  }
  async abort(): Promise<void> {
    this.aborted += 1
  }
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('a person steering a running task', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-task-steer-'))
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    resetRunSteers()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Team',
        icon: '🚀',
        color: '#e94560',
        leaderAgentId: LEAD,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        { id: LEAD, name: 'Lead', gatewayId: LEAD, teamId: TEAM, createdAt: now, updatedAt: now },
        {
          id: WORKER,
          name: 'Writer',
          gatewayId: WORKER,
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run()
  })
  afterEach(async () => {
    resetDb()
    resetRunSteers()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  it('reaches the run mid-flight; the task stays in progress and completes ONCE, no failure', async () => {
    const lead = new LeadAdapter()
    const worker = new SteeredWorkerAdapter()
    const abortMap = new Map<string, RunEntry>()
    const engineRef: { current: BoardOrchestrator | null } = { current: null }
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap,
      onEvent: (sk, e, run) => engineRef.current!.onEvent(sk, e, run),
      onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
      stopGen: () => 0,
      leaderAgentId: () => LEAD,
      makeAdapterForAgent: (id) => (id === LEAD ? lead : id === WORKER ? worker : null),
    })
    const engine = createBoardOrchestrator({
      teamId: TEAM,
      board: createServerBoardClient(db),
      known: () => [
        { id: LEAD, name: 'Lead' },
        { id: WORKER, name: 'Writer' },
      ],
      leaderAgentId: () => LEAD,
      sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      deliver,
      stopGen: () => 0,
      caps: { maxFanout: 8 },
    })
    engineRef.current = engine

    await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
    // The worker's run is live on its task and registered for steering.
    await settle(() => {
      const t = listTasks(db, { teamId: TEAM })[0]
      return t?.status === 'in_progress' && hasRunForTask(t.id)
    }, "the worker's run going live on its task")
    const task = listTasks(db, { teamId: TEAM })[0]!
    expect(engine.taskForSession(skFor(WORKER))).toBe(task.id)

    const outcome = forwardPersonCommentToRun(db, task, 'Keep it under 200 words.')
    expect(outcome.forwarded).toBe(true)
    await vi.advanceTimersByTimeAsync(STEER_BATCH_MS)
    await expect(outcome.steer).resolves.toEqual({ delivered: true, mode: 'interrupt-resume' })
    expect(worker.steers).toHaveLength(1)
    expect(worker.steers[0]).toContain('Keep it under 200 words.')
    // A team run reads comments from its ticket block, so nothing waits in the mailbox.
    expect(listUndeliveredInbox(db, WORKER, { teamId: TEAM })).toHaveLength(0)

    // Let the resumed run finish and the reflection reach the lead.
    await settle(() => lead.messages.length >= 2, "the lead's reflection turn")

    const after = listTasks(db, { teamId: TEAM })[0]!
    expect(after.status).toBe('done')
    expect(after.assigneeAgentId).toBe(WORKER)
    // One run, one execution, succeeded: the stop inside the steer never surfaced.
    const execs = listExecutions(db, after.id)
    expect(execs).toHaveLength(1)
    expect(execs[0]!.status).toBe('succeeded')
    expect(worker.aborted).toBe(0)
    expect(
      getComments(db, after.id)
        .map((c) => c.body)
        .join('\n'),
    ).toContain('Short post.')
    // The lead hears a success, not a failure.
    expect(lead.messages[1]).toContain('[Task Update]')
    expect(lead.messages[1]).not.toMatch(/DID NOT COMPLETE/)
    // The run is over, so nothing is left to steer.
    expect(hasRunForTask(after.id)).toBe(false)
  })

  it('comments in a burst go in as one steer', async () => {
    const steers: string[] = []
    const { createTask, claimTask } = await import('@clawboo/db')
    const t = createTask(db, { title: 'Draft', teamId: TEAM, status: 'todo' })
    expect(claimTask(db, t.id, WORKER).ok).toBe(true)
    const task = listTasks(db, { teamId: TEAM }).find((x) => x.id === t.id)!
    const handle = registerRunSteer(
      t.id,
      {
        capabilities: () => ({
          streaming: true,
          mcp: false,
          worktrees: false,
          resume: false,
          toolApproval: false,
          models: [],
          steering: 'live',
        }),
        steer: async (_r, text) => {
          steers.push(text)
          return { delivered: true, mode: 'live' }
        },
      },
      { adapterId: 'x', sessionKey: 'x', runId: null },
    )
    const first = forwardPersonCommentToRun(db, task, 'One.')
    const second = forwardPersonCommentToRun(db, task, 'Two.')
    await vi.advanceTimersByTimeAsync(STEER_BATCH_MS)
    await expect(first.steer).resolves.toMatchObject({ delivered: true })
    await expect(second.steer).resolves.toMatchObject({ delivered: true })
    expect(steers).toHaveLength(1)
    expect(steers[0]).toContain('1. One.')
    expect(steers[0]).toContain('2. Two.')
    // A later comment is the next batch.
    const third = forwardPersonCommentToRun(db, task, 'Three.')
    await vi.advanceTimersByTimeAsync(STEER_BATCH_MS)
    await expect(third.steer).resolves.toMatchObject({ delivered: true })
    expect(steers).toHaveLength(2)
    handle.release()
  })

  it('a comment a run took when its context rendered is not steered as well', async () => {
    const { createTask, claimTask, recordTaskWake, adoptTaskWakes, addComment } =
      await import('@clawboo/db')
    const t = createTask(db, { title: 'Draft', teamId: TEAM, status: 'todo' })
    const exec = claimTask(db, t.id, WORKER, 'codex', {
      run: { executorType: 'openclaw' },
    }).execution!
    const task = listTasks(db, { teamId: TEAM }).find((x) => x.id === t.id)!
    const steers: string[] = []
    const handle = registerRunSteer(
      t.id,
      {
        capabilities: () => ({
          streaming: true,
          mcp: false,
          worktrees: false,
          resume: false,
          toolApproval: false,
          models: [],
          steering: 'live',
        }),
        steer: async (_r, text) => {
          steers.push(text)
          return { delivered: true, mode: 'live' }
        },
      },
      { adapterId: 'x', sessionKey: 'x', runId: null },
    )
    const comment = addComment(db, t.id, 'Use the new logo.', 'user', null, { kind: 'person' })
    recordTaskWake(db, {
      teamId: TEAM,
      agentId: WORKER,
      taskId: t.id,
      reason: 'person_comment',
      commentIds: [comment.id],
    })
    const outcome = forwardPersonCommentToRun(db, task, 'Use the new logo.', {
      commentId: comment.id,
    })
    // While it waits for others to batch with, a run renders its context and takes it.
    expect(adoptTaskWakes(db, t.id, exec.id)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(STEER_BATCH_MS)
    await expect(outcome.steer).resolves.toMatchObject({ delivered: true })
    expect(steers).toEqual([])
    handle.release()
  })

  it('a comment with no run to steer stays in the mailbox of a task the runner runs', async () => {
    const { createTask, claimTask } = await import('@clawboo/db')
    const t = createTask(db, { title: 'Draft', teamId: TEAM, status: 'todo' })
    expect(claimTask(db, t.id, WORKER).ok).toBe(true)
    const task = listTasks(db, { teamId: TEAM }).find((x) => x.id === t.id)!
    const outcome = forwardPersonCommentToRun(db, task, 'Use the new logo.', { mailbox: true })
    await vi.advanceTimersByTimeAsync(STEER_BATCH_MS)
    await expect(outcome.steer).resolves.toEqual({ delivered: false, reason: 'no-run' })
    const rows = listUndeliveredInbox(db, WORKER, { teamId: TEAM })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toContain('Use the new logo.')
  })
})
