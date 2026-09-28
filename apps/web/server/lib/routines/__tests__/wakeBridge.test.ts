// The wake-bridge dispatch BRANCHES on the capability seam, never an id
// switch. Per-class fire: wrapped-oneshot + native agents route through the
// injected one-shot runner (with the mirrored RunTaskInput: apiKeyEnv,
// scheduledBy:'clawboo' on the materialized task, dormant tenantId); an
// OpenClaw (connected-substrate) agent routes through the connected dispatcher
// and NEVER touches the one-shot runner; a human participant throws the typed
// NotImplementedError.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  createDb,
  createTask,
  getComments,
  getTask,
  listEvents,
  listTasks,
  registerScheduledRun,
  setSetting,
  teams,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'
import { NotImplementedError } from '@clawboo/scheduler'
import { eq } from 'drizzle-orm'

import type { runTaskOnRuntime } from '../../executorRunner'
import type { EnqueueUserMessageInput } from '../../teamChat/teamOrchestrator'
import { dispatchRoutine, runKindFor } from '../wakeBridge'
import type { dispatchConnectedSubstrate } from '../openclawDispatch'

type RunTaskInput = Parameters<typeof runTaskOnRuntime>[0]

let dir: string
let db: ClawbooDb

function seedAgent(id: string, runtime: string, participantKind = 'agent'): void {
  const now = Date.now()
  db.insert(agents)
    .values({
      id,
      name: id,
      gatewayId: id,
      sourceId: runtime === 'openclaw' ? 'openclaw' : 'clawboo-native',
      sourceAgentId: id,
      participantKind,
      runtime,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

function seedRoutine(agentId: string, template: Record<string, unknown> = {}): DbScheduledRun {
  const result = registerScheduledRun(db, {
    agentId,
    teamId: 'team-1',
    cronSpec: '0 9 * * *',
    taskTemplate: JSON.stringify({
      title: 'Scheduled chore',
      kind: 'research',
      priority: 1,
      ...template,
    }),
    nextRunAt: 1_000,
    tenantId: null,
  })
  if (!result.ok) throw new Error(`register failed: ${result.reason}`)
  return result.run
}

function seedTeam(id: string, opts: { archived?: boolean } = {}): void {
  const now = Date.now()
  db.insert(teams)
    .values({
      id,
      name: `Team ${id}`,
      icon: 'T',
      color: '#123456',
      isArchived: opts.archived ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

function seedTeamRoutine(
  teamId: string | null,
  template: Record<string, unknown> = {},
): DbScheduledRun {
  const result = registerScheduledRun(db, {
    agentId: '',
    teamId,
    cronSpec: '0 9 * * *',
    taskTemplate: JSON.stringify({
      title: 'Morning briefing',
      description: 'Summarize what shipped yesterday.',
      target: 'team',
      ...template,
    }),
    nextRunAt: 1_000,
    tenantId: null,
  })
  if (!result.ok) throw new Error(`register failed: ${result.reason}`)
  return result.run
}

const SUCCESS = {
  ok: true as const,
  runtimeId: 'clawboo-native',
  execId: 'e1',
  doneReason: 'success' as const,
  status: 'done',
  summary: 'ok',
  costUsd: null,
  usedWorktree: false,
  degradations: [],
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-wakebridge-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  // This suite OWNS its connection (createDb at a fixture path), so resetDb()
  // cannot reach it: that only evicts the getDb() memo. Windows refuses to
  // remove a directory that still holds an open file, so close it before the
  // rm. Mirrors the ownership rule in lib/db.ts. (#140)
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('dispatchRoutine', () => {
  it('WRAPPED-ONESHOT: routes through the one-shot runner with the mirrored input', async () => {
    seedAgent('agent-cc', 'claude-code')
    const run = seedRoutine('agent-cc', { repoPath: '/tmp/repo', model: 'haiku', maxNodeCents: 50 })
    const calls: RunTaskInput[] = []
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: 'http://127.0.0.1:19999',
      runTask: async (input) => {
        calls.push(input)
        return {
          ok: true,
          runtimeId: 'claude-code',
          execId: 'e1',
          doneReason: 'success',
          status: 'done',
          summary: 'did the chore',
          costUsd: 0.01,
          usedWorktree: true,
          degradations: [],
        }
      },
    })

    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const input = calls[0]!
    expect(input.assigneeAgentId).toBe('agent-cc')
    expect(input.repoPath).toBe('/tmp/repo')
    expect(input.kind).toBe('research')
    expect(input.model).toBe('haiku')
    expect(input.maxNodeCents).toBe(50)
    expect(input.mcpBaseUrl).toBe('http://127.0.0.1:19999')

    // The materialized board task carries the firing-owner label + tenantId.
    const task = getTask(db, input.taskId)
    expect(task).toMatchObject({
      title: 'Scheduled chore',
      status: 'todo',
      scheduledBy: 'clawboo',
      assigneeRuntime: 'claude-code',
      teamId: 'team-1',
      tenantId: null,
    })
  })

  it('NATIVE: routes through the same one-shot runner', async () => {
    seedAgent('agent-native', 'clawboo-native')
    const run = seedRoutine('agent-native')
    const calls: RunTaskInput[] = []
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async (input) => {
        calls.push(input)
        return {
          ok: true,
          runtimeId: 'clawboo-native',
          execId: 'e1',
          doneReason: 'success',
          status: 'done',
          summary: 'ok',
          costUsd: null,
          usedWorktree: false,
          degradations: [],
        }
      },
    })
    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('CONNECTED-SUBSTRATE: routes through the connected dispatcher, NEVER the one-shot runner', async () => {
    seedAgent('agent-oc', 'openclaw')
    const run = seedRoutine('agent-oc')
    const connectedCalls: Array<Parameters<typeof dispatchConnectedSubstrate>[0]> = []
    let oneShotCalled = false
    const fakeClient = {} as never

    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async () => {
        oneShotCalled = true
        throw new Error('one-shot runner must not be reached for a connected substrate')
      },
      getOperatorClient: () => fakeClient,
      dispatchConnected: async (input) => {
        connectedCalls.push(input)
        return { ok: true, taskId: input.taskId }
      },
    })

    expect(outcome.ok).toBe(true)
    expect(oneShotCalled).toBe(false)
    expect(connectedCalls).toHaveLength(1)
    expect(getTask(db, connectedCalls[0]!.taskId)?.scheduledBy).toBe('clawboo')
  })

  it('CONNECTED-SUBSTRATE with the Gateway down: outcome error, no task materialized', async () => {
    seedAgent('agent-oc', 'openclaw')
    const run = seedRoutine('agent-oc')
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      getOperatorClient: () => null,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('gateway_disconnected')
    expect(listTasks(db)).toHaveLength(0)
  })

  it('HUMAN participant: throws the typed NotImplementedError (the humans-in-the-graph seam)', async () => {
    seedAgent('agent-human', 'clawboo-native', 'human')
    const run = seedRoutine('agent-human')
    await expect(dispatchRoutine(run, { db, mcpBaseUrl: null })).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })

  it('a BOUND team task is dispatched as-is when claimable, refused when not', async () => {
    seedAgent('agent-cc', 'claude-code')
    const bound = createTask(db, { title: 'Bound chore', status: 'todo', scheduledBy: 'clawboo' })
    const run = seedRoutine('agent-cc', { teamTaskId: bound.id })
    const calls: RunTaskInput[] = []
    const ok = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async (input) => {
        calls.push(input)
        return {
          ok: true,
          runtimeId: 'claude-code',
          execId: 'e1',
          doneReason: 'success',
          status: 'done',
          summary: 'ok',
          costUsd: null,
          usedWorktree: false,
          degradations: [],
        }
      },
    })
    expect(ok.ok).toBe(true)
    expect(calls[0]?.taskId).toBe(bound.id)
    // No extra task was materialized.
    expect(listTasks(db)).toHaveLength(1)

    // Park the bound task in a non-claimable state → the fire refuses.
    const done = createTask(db, { title: 'Done chore', status: 'done', scheduledBy: 'clawboo' })
    const run2 = seedRoutine('agent-cc', { teamTaskId: done.id })
    const refused = await dispatchRoutine(run2, { db, mcpBaseUrl: null })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('not claimable')
  })

  it('a LOST claim (conflict) is satisfied, never retried', async () => {
    seedAgent('agent-cc', 'claude-code')
    const run = seedRoutine('agent-cc')
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async () => ({ ok: false, reason: 'conflict' }),
    })
    expect(outcome.ok).toBe(true)
  })

  it('a non-success run becomes an outcome error (the ledger parks the routine)', async () => {
    seedAgent('agent-cc', 'claude-code')
    const run = seedRoutine('agent-cc')
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async () => ({
        ok: true,
        runtimeId: 'claude-code',
        execId: 'e1',
        doneReason: 'error',
        status: 'todo',
        summary: 'provider exploded',
        costUsd: null,
        usedWorktree: false,
        degradations: [],
      }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('provider exploded')
  })

  it('FAIL-CLOSED: an unknown/typo runtime is NOT silently dispatched over OpenClaw', async () => {
    seedAgent('agent-typo', 'claude-codex-typo') // neither a known RuntimeId nor openclaw
    const run = seedRoutine('agent-typo')
    let askedOperator = false
    const runCalls: unknown[] = []
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async (input) => {
        runCalls.push(input)
        return { ok: false, reason: 'not_found' }
      },
      getOperatorClient: () => {
        askedOperator = true
        return null
      },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('unknown runtime')
    expect(askedOperator).toBe(false) // never reached the OpenClaw operator branch
    expect(runCalls).toHaveLength(0) // never reached the one-shot runner
  })
})

describe('runKindFor', () => {
  it('runs a worktree kind with no repository without a worktree', () => {
    expect(runKindFor({ kind: 'code', repoPath: null })).toBe('research')
    expect(runKindFor({ kind: 'code', repoPath: undefined })).toBe('research')
    expect(runKindFor({ kind: 'something-new', repoPath: '' })).toBe('research')
  })

  it('keeps the kind when a repository is named, or when the kind needs no worktree', () => {
    expect(runKindFor({ kind: 'code', repoPath: '/tmp/repo' })).toBe('code')
    expect(runKindFor({ kind: 'research', repoPath: null })).toBe('research')
    expect(runKindFor({ kind: 'review', repoPath: null })).toBe('review')
  })
})

describe('dispatchRoutine: agent routines', () => {
  it('an agent routine with no repository runs without a worktree, even if its kind says code', async () => {
    seedAgent('agent-native', 'clawboo-native')
    const run = seedRoutine('agent-native', { kind: 'code' })
    const calls: RunTaskInput[] = []
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async (input) => {
        calls.push(input)
        return SUCCESS
      },
    })
    expect(outcome.ok).toBe(true)
    expect(calls[0]?.kind).toBe('research')
    expect(calls[0]?.repoPath).toBeNull()
  })

  it('a legacy template (no target, default kind) is an agent routine and runs', async () => {
    seedAgent('agent-native', 'clawboo-native')
    const result = registerScheduledRun(db, {
      agentId: 'agent-native',
      teamId: 'team-1',
      cronSpec: '0 9 * * *',
      taskTemplate: JSON.stringify({ title: 'Old routine', kind: 'code', priority: 0 }),
      nextRunAt: 1_000,
    })
    if (!result.ok) throw new Error('register failed')
    const calls: RunTaskInput[] = []
    const outcome = await dispatchRoutine(result.run, {
      db,
      mcpBaseUrl: null,
      runTask: async (input) => {
        calls.push(input)
        return SUCCESS
      },
    })
    expect(outcome.ok).toBe(true)
    expect(calls[0]).toMatchObject({ assigneeAgentId: 'agent-native', kind: 'research' })
  })

  it('reaches the mock runtime when its flag is on, and refuses it when off', async () => {
    seedAgent('agent-mock', 'clawboo-mock')
    const prev = process.env['CLAWBOO_ENABLE_MOCK_RUNTIME']
    try {
      delete process.env['CLAWBOO_ENABLE_MOCK_RUNTIME']
      const off = await dispatchRoutine(seedRoutine('agent-mock'), { db, mcpBaseUrl: null })
      expect(off).toMatchObject({ ok: false })
      expect(off.error).toContain('unknown runtime')

      process.env['CLAWBOO_ENABLE_MOCK_RUNTIME'] = '1'
      const calls: RunTaskInput[] = []
      const on = await dispatchRoutine(seedRoutine('agent-mock'), {
        db,
        mcpBaseUrl: null,
        runTask: async (input) => {
          calls.push(input)
          return SUCCESS
        },
      })
      expect(on.ok).toBe(true)
      expect(calls[0]?.assigneeAgentId).toBe('agent-mock')
    } finally {
      if (prev === undefined) delete process.env['CLAWBOO_ENABLE_MOCK_RUNTIME']
      else process.env['CLAWBOO_ENABLE_MOCK_RUNTIME'] = prev
    }
  })

  it('a failed fire sets the task it created aside as blocked, with a note', async () => {
    seedAgent('agent-native', 'clawboo-native')
    const run = seedRoutine('agent-native')
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      // What the runner does with a failed run: the task goes back to todo.
      runTask: async () => ({ ...SUCCESS, doneReason: 'error' as const, summary: 'boom' }),
    })
    expect(outcome.ok).toBe(false)
    const task = getTask(db, outcome.taskId!)
    expect(task?.status).toBe('blocked')
    expect(getComments(db, outcome.taskId!).map((c) => c.body)).toContain(
      "agent-native's scheduled run failed: run error: boom. The routine files a new task on its next run, so this one was set aside.",
    )
  })

  it('a runner that throws is a failed fire too, and its task is set aside', async () => {
    seedAgent('agent-native', 'clawboo-native')
    const run = seedRoutine('agent-native')
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      // A home-mutex acquire timeout throws before the claim, leaving the task todo.
      runTask: async () => {
        throw new Error('timed out waiting for the agent home')
      },
    })
    expect(outcome).toMatchObject({ ok: false, error: 'timed out waiting for the agent home' })
    expect(getTask(db, outcome.taskId!)?.status).toBe('blocked')
    expect(getComments(db, outcome.taskId!).map((c) => c.body)).toContain(
      "agent-native's scheduled run failed: timed out waiting for the agent home. The routine files a new task on its next run, so this one was set aside.",
    )
  })

  it('a connected dispatcher that throws is a failed fire too, and its task is set aside', async () => {
    seedAgent('agent-oc', 'openclaw')
    const run = seedRoutine('agent-oc')
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      getOperatorClient: () => ({}) as never,
      dispatchConnected: async () => {
        throw new Error('operator socket closed')
      },
    })
    expect(outcome).toMatchObject({ ok: false, error: 'operator socket closed' })
    expect(getTask(db, outcome.taskId!)?.status).toBe('blocked')
  })

  it('a failed fire of a BOUND task leaves that task as the runner left it', async () => {
    seedAgent('agent-cc', 'claude-code')
    const bound = createTask(db, { title: 'Bound chore', status: 'todo', scheduledBy: 'clawboo' })
    const run = seedRoutine('agent-cc', { teamTaskId: bound.id })
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async () => ({ ...SUCCESS, doneReason: 'error' as const, summary: 'boom' }),
    })
    expect(outcome.ok).toBe(false)
    expect(getTask(db, bound.id)?.status).toBe('todo')
  })

  it('an agent that was removed is not dispatched and no task is created', async () => {
    seedAgent('agent-gone', 'clawboo-native')
    db.update(agents).set({ archivedAt: Date.now() }).where(eq(agents.id, 'agent-gone')).run()
    const run = seedRoutine('agent-gone')
    let ran = false
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async () => {
        ran = true
        return SUCCESS
      },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('was removed')
    expect(ran).toBe(false)
    expect(listTasks(db)).toHaveLength(0)
  })
})

describe('dispatchRoutine: team routines', () => {
  it('posts the instructions to the team chat for its lead and creates no board task', async () => {
    seedTeam('team-1')
    seedAgent('boo-zero', 'clawboo-native')
    const run = seedTeamRoutine('team-1')
    const posted: Array<{ teamId: string; input: EnqueueUserMessageInput }> = []
    let ranTask = false
    const outcome = await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      runTask: async () => {
        ranTask = true
        return SUCCESS
      },
      enqueueTeamMessage: async (teamId, input) => {
        posted.push({ teamId, input })
        return { ok: true, targetAgentId: 'boo-zero' }
      },
    })

    expect(outcome).toEqual({ ok: true, taskId: null })
    expect(posted).toEqual([
      {
        teamId: 'team-1',
        input: {
          stimulus: 'Summarize what shipped yesterday.',
          routine: { id: run.id, name: 'Morning briefing' },
        },
      },
    ])
    expect(ranTask).toBe(false)
    expect(listTasks(db)).toHaveLength(0)

    const [dispatched] = listEvents(db, { kinds: ['routine_dispatched'] })
    expect(dispatched).toMatchObject({ teamId: 'team-1', agentId: 'boo-zero' })
    expect(JSON.parse(dispatched!.data)).toMatchObject({
      scheduledRunId: run.id,
      taskId: null,
      dispatchPath: 'team-chat',
      targetAgentId: 'boo-zero',
      runtime: 'clawboo-native',
    })
  })

  it('posts the routine name when it carries no instructions', async () => {
    seedTeam('team-1')
    const run = seedTeamRoutine('team-1', { description: '   ' })
    const posted: EnqueueUserMessageInput[] = []
    await dispatchRoutine(run, {
      db,
      mcpBaseUrl: null,
      enqueueTeamMessage: async (_teamId, input) => {
        posted.push(input)
        return { ok: true, targetAgentId: 'boo-zero' }
      },
    })
    expect(posted[0]?.stimulus).toBe('Morning briefing')
  })

  it('refuses a routine whose team is missing, gone, archived, or closed to routines', async () => {
    const enqueueTeamMessage = async () => {
      throw new Error('must not post')
    }
    const noTeam = await dispatchRoutine(seedTeamRoutine(null), {
      db,
      mcpBaseUrl: null,
      enqueueTeamMessage,
    })
    expect(noTeam).toMatchObject({ ok: false, error: 'This team routine has no team.' })

    const gone = await dispatchRoutine(seedTeamRoutine('team-gone'), {
      db,
      mcpBaseUrl: null,
      enqueueTeamMessage,
    })
    expect(gone.ok).toBe(false)
    expect(gone.error).toContain('no longer exists')

    seedTeam('team-old', { archived: true })
    const archived = await dispatchRoutine(seedTeamRoutine('team-old'), {
      db,
      mcpBaseUrl: null,
      enqueueTeamMessage,
    })
    expect(archived.ok).toBe(false)
    expect(archived.error).toContain('archived')

    seedTeam('team-browser')
    setSetting(db, 'team-server-orchestrated:team-browser', 'false')
    const closed = await dispatchRoutine(seedTeamRoutine('team-browser'), {
      db,
      mcpBaseUrl: null,
      enqueueTeamMessage,
    })
    expect(closed.ok).toBe(false)
    expect(closed.error).toContain('does not take messages from routines')
  })

  it('a message the team could not take becomes the outcome error', async () => {
    seedTeam('team-1')
    const outcome = await dispatchRoutine(seedTeamRoutine('team-1'), {
      db,
      mcpBaseUrl: null,
      enqueueTeamMessage: async () => ({ ok: false, error: 'The team has no active members.' }),
    })
    expect(outcome).toEqual({ ok: false, error: 'The team has no active members.' })
    expect(listEvents(db, { kinds: ['routine_dispatched'] })).toHaveLength(0)
  })
})
