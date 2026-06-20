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
  getTask,
  listTasks,
  registerScheduledRun,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'
import { NotImplementedError } from '@clawboo/scheduler'

import type { runTaskOnRuntime } from '../../executorRunner'
import { dispatchRoutine } from '../wakeBridge'
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

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-wakebridge-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
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
