// Every approval row is announced in the event log: once when it opens, once when
// it settles. Whatever follows the log, the Activity feeds and GET /api/obs/events
// among them, learns about approvals only from these events, so an approval the
// log never mentions is invisible to all of it. These pin both halves for every
// path in the db layer, and pin that the arguments never ride along.

import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createDb, type ClawbooDb } from '../../db'
import { listEvents } from '../../events/listEvents'
import { listStandingRules, upsertGrant } from '../../grants/repository'
import { resetRateWindows } from '../../grants/rateWindow'
import { agents, teams } from '../../schema'
import { defaultAvailabilityContext } from '../availability'
import { executeBrokeredCall } from '../broker'
import {
  createApproval,
  expireStaleApprovals,
  getApproval,
  listPendingApprovals,
  resolveApproval,
  waitForApproval,
} from '../persistence'
import { ToolRegistry } from '../registry'
import type { ToolCallContext } from '../types'

const SECRET_ARG = 'quarterly-layoffs-draft.txt'
const CONNECTOR = 'conn:native:clawboo-native:mcp:github'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-approval-events-'))
  db = createDb(path.join(dir, 'test.db'))
  resetRateWindows()
  const now = Date.now()
  db.insert(teams)
    .values({ id: 'team-1', name: 'Ops', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
    .run()
  db.insert(agents)
    .values({
      id: 'boo-1',
      name: 'Boo',
      gatewayId: 'boo-1',
      status: 'idle',
      teamId: 'team-1',
      createdAt: now,
      updatedAt: now,
    })
    .run()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const approvalEvents = () =>
  listEvents(db, { kinds: ['approval_requested', 'approval_resolved'] }).map((e) => ({
    kind: e.kind,
    agentId: e.agentId,
    teamId: e.teamId,
    taskId: e.taskId,
    tenantId: e.tenantId,
    data: JSON.parse(e.data) as Record<string, unknown>,
  }))

/** Move a card's deadline into the past, as the clock would. */
const pastDeadline = (id: string) =>
  db.$client
    .prepare('UPDATE tool_call_approvals SET expires_at = ? WHERE id = ?')
    .run(Date.now() - 1_000, id)

const ctx = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
  availability: defaultAvailabilityContext({ env: {} }),
  ...over,
})

describe('createApproval', () => {
  it('announces the new approval once, with its team read from the agent', () => {
    const a = createApproval(db, {
      toolName: 'files_delete',
      agentId: 'boo-1',
      args: { path: SECRET_ARG },
      reason: `wants to delete ${SECRET_ARG}`,
      taskId: 'task-9',
      tenantId: 'tenant-1',
      grantId: 'g-1',
      connectorId: CONNECTOR,
      toolClass: 'destructive',
      toolSummary: `delete ${SECRET_ARG}`,
    })

    expect(approvalEvents()).toEqual([
      {
        kind: 'approval_requested',
        agentId: 'boo-1',
        teamId: 'team-1',
        taskId: 'task-9',
        tenantId: 'tenant-1',
        data: {
          approvalId: a.id,
          kind: 'tool',
          toolName: 'files_delete',
          toolClass: 'destructive',
          grantId: 'g-1',
          connectorId: CONNECTOR,
          expiresAt: a.expiresAt,
        },
      },
    ])
  })

  it('never carries the arguments, the reason or the summary', () => {
    createApproval(db, {
      toolName: 'files_delete',
      agentId: 'boo-1',
      args: { path: SECRET_ARG },
      reason: `wants to delete ${SECRET_ARG}`,
      toolSummary: `delete ${SECRET_ARG}`,
    })
    const raw = listEvents(db, { kinds: ['approval_requested'] })
    expect(raw).toHaveLength(1)
    expect(raw[0]!.data).not.toContain(SECRET_ARG)
  })

  it("uses the caller's team when it knows one, including knowing there is none", () => {
    createApproval(db, { toolName: 't', agentId: 'boo-1', args: {}, teamId: 'team-from-ctx' })
    createApproval(db, { toolName: 't', agentId: 'boo-1', args: {}, teamId: null })
    expect(approvalEvents().map((e) => e.teamId)).toEqual(['team-from-ctx', null])
  })

  it('leaves the team empty for an agent clawboo has no row for', () => {
    createApproval(db, { toolName: 't', agentId: 'unmapped-openclaw-id', args: {} })
    expect(approvalEvents()[0]?.teamId).toBeNull()
  })
})

describe('resolveApproval', () => {
  for (const decision of ['allow_once', 'allow_always', 'deny'] as const) {
    it(`announces ${decision} once, and a second answer not at all`, () => {
      const a = createApproval(db, { toolName: 'files_delete', agentId: 'boo-1', args: {} })
      resolveApproval(db, a.id, decision)
      resolveApproval(db, a.id, decision === 'deny' ? 'allow_once' : 'deny')

      const resolved = approvalEvents().filter((e) => e.kind === 'approval_resolved')
      expect(resolved).toEqual([
        {
          kind: 'approval_resolved',
          agentId: 'boo-1',
          teamId: 'team-1',
          taskId: null,
          tenantId: null,
          data: { approvalId: a.id, decision, kind: 'tool', toolName: 'files_delete' },
        },
      ])
    })
  }

  it('announces an Always even when minting its rule fails', () => {
    // The row is settled before the mint, and a second resolve changes nothing,
    // so an event skipped here could never be written later.
    const a = createApproval(db, {
      toolName: 'gh_comment',
      agentId: 'boo-1',
      args: {},
      grantId: 'g-1',
    })
    db.$client.exec('DROP TABLE approval_rules')
    expect(() => resolveApproval(db, a.id, 'allow_always')).toThrow()

    const resolved = approvalEvents().filter((e) => e.kind === 'approval_resolved')
    expect(resolved.map((e) => e.data)).toEqual([
      { approvalId: a.id, decision: 'allow_always', kind: 'tool', toolName: 'gh_comment' },
    ])
  })

  it('announces nothing for an id that has no row', () => {
    resolveApproval(db, 'nope', 'deny')
    expect(approvalEvents()).toEqual([])
  })

  it('refuses an answer past expiresAt and expires the card instead, once', () => {
    // Nothing is waiting on a card past its deadline, for example because the
    // process holding it stopped. An answer stored there would run nothing,
    // and an Always would still mint a rule from a prompt that had closed.
    const grant = upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'boo-1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    const a = createApproval(db, {
      toolName: 'gh_comment',
      agentId: 'boo-1',
      args: {},
      grantId: grant.id,
    })
    pastDeadline(a.id)

    expect(resolveApproval(db, a.id, 'allow_always')?.status).toBe('expired')
    expect(resolveApproval(db, a.id, 'deny')?.status).toBe('expired')
    expect(listStandingRules(db, grant.id)).toEqual([])
    const resolved = approvalEvents().filter((e) => e.kind === 'approval_resolved')
    expect(resolved.map((e) => e.data)).toEqual([
      { approvalId: a.id, decision: 'expired', kind: 'tool', toolName: 'gh_comment' },
    ])
  })

  it('refuses an answer that waited out a busy lock past the deadline', async () => {
    // Another connection holds the write lock and moves the deadline to just
    // ahead of now. The answer below is sent before that deadline but can only
    // write after the lock is released, which is after it.
    const a = createApproval(db, { toolName: 'gh_comment', agentId: 'boo-1', args: {} })
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads')
       const Database = require(workerData.driver)
       const conn = new Database(workerData.dbPath)
       conn.exec('BEGIN IMMEDIATE')
       conn.prepare('UPDATE tool_call_approvals SET expires_at = ? WHERE id = ?')
         .run(Date.now() + 300, workerData.id)
       parentPort.postMessage('locked')
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900)
       conn.exec('COMMIT')
       conn.close()`,
      {
        eval: true,
        workerData: {
          // __filename is provided by vitest for this CommonJS package.
          driver: createRequire(__filename).resolve('better-sqlite3'),
          dbPath: path.join(dir, 'test.db'),
          id: a.id,
        },
      },
    )
    const exited = new Promise((resolve) => worker.once('exit', resolve))
    await new Promise((resolve) => worker.once('message', resolve))

    expect(resolveApproval(db, a.id, 'allow_once')?.status).toBe('expired')
    await exited
  })
})

describe('expireStaleApprovals', () => {
  it('announces each expired row once; a second pass announces nothing', async () => {
    const a = createApproval(db, { toolName: 'delegate:code', agentId: 'boo-1', args: {} })
    const fresh = createApproval(db, { toolName: 'later', agentId: 'boo-1', args: {} })
    db.$client
      .prepare('UPDATE tool_call_approvals SET created_at = ? WHERE id = ?')
      .run(Date.now() - 60_000, a.id)

    expect(expireStaleApprovals(db, { olderThanMs: 30_000 }).map((r) => r.id)).toEqual([a.id])
    expect(expireStaleApprovals(db, { olderThanMs: 30_000 })).toEqual([])

    const resolved = approvalEvents().filter((e) => e.kind === 'approval_resolved')
    expect(resolved.map((e) => e.data)).toEqual([
      { approvalId: a.id, decision: 'expired', kind: 'tool', toolName: 'delegate:code' },
    ])
    expect(resolved.some((e) => e.data['approvalId'] === fresh.id)).toBe(false)
  })
})

describe('waitForApproval', () => {
  // A waiter that stops waiting closes its own card. A pending card nobody
  // waits on is answerable for nobody, counts on the grant's edge, and stays
  // out of the log until the reaper finds it a day later.
  const resolvedEvents = () => approvalEvents().filter((e) => e.kind === 'approval_resolved')

  it('expires a card past its expiresAt and announces it once', async () => {
    const a = createApproval(db, { toolName: 'gh_comment', agentId: 'boo-1', args: {} })
    pastDeadline(a.id)

    expect(await waitForApproval(db, a.id, { pollMs: 5 })).toBe('expired')
    const row = getApproval(db, a.id)
    expect(row?.status).toBe('expired')
    expect(row?.resolvedAt).toEqual(expect.any(Number))
    expect(resolvedEvents()).toEqual([
      {
        kind: 'approval_resolved',
        agentId: 'boo-1',
        teamId: 'team-1',
        taskId: null,
        tenantId: null,
        data: { approvalId: a.id, decision: 'expired', kind: 'tool', toolName: 'gh_comment' },
      },
    ])

    // Nothing after it announces the card again: not a late click, not the reaper.
    resolveApproval(db, a.id, 'allow_once')
    expect(expireStaleApprovals(db, { olderThanMs: 0 })).toEqual([])
    expect(resolvedEvents()).toHaveLength(1)
    expect(getApproval(db, a.id)?.status).toBe('expired')
  })

  it('expires the card when its own deadline passes first, and still says timeout', async () => {
    const a = createApproval(db, { toolName: 'gh_comment', agentId: 'boo-1', args: {} })

    expect(await waitForApproval(db, a.id, { timeoutMs: 20, pollMs: 5 })).toBe('timeout')
    expect(getApproval(db, a.id)?.status).toBe('expired')
    expect(listPendingApprovals(db)).toEqual([])
    expect(resolvedEvents().map((e) => e.data)).toEqual([
      { approvalId: a.id, decision: 'expired', kind: 'tool', toolName: 'gh_comment' },
    ])
  })

  it('lets an answer that lands as it gives up win, and returns that answer', async () => {
    // The stdio tools bin waits in one process while the dashboard answers in
    // another, so an answer can land between the waiter's read and its write.
    // Only before expiresAt: after it, resolveApproval refuses the answer.
    const a = createApproval(db, { toolName: 'gh_comment', agentId: 'boo-1', args: {} })
    const update = db.update.bind(db)
    const spy = vi.spyOn(db, 'update').mockImplementationOnce((table) => {
      resolveApproval(db, a.id, 'allow_once')
      return update(table)
    })

    try {
      expect(await waitForApproval(db, a.id, { timeoutMs: 0, pollMs: 5 })).toBe('allow_once')
    } finally {
      spy.mockRestore()
    }
    expect(getApproval(db, a.id)?.status).toBe('allow_once')
    expect(resolvedEvents().map((e) => e.data['decision'])).toEqual(['allow_once'])
  })
})

describe('the broker', () => {
  async function waitForPending(): Promise<string> {
    for (let i = 0; i < 400 && listPendingApprovals(db).length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const [row] = listPendingApprovals(db)
    if (!row) throw new Error('the broker never asked')
    return row.id
  }

  it('announces the approval it opens and the answer that releases it', async () => {
    const grant = upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'boo-1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      mode: 'write',
      approvalPolicy: 'risk',
    })
    const registry = new ToolRegistry()
    registry.register({
      name: 'gh_comment',
      description: 'Comment on an issue.',
      inputSchema: z.object({ body: z.string() }),
      owner: 'mcp',
      readOnly: false,
      risk: 'external',
      executor: () => 'ok',
    })
    const call = () =>
      executeBrokeredCall(
        db,
        { name: 'gh_comment', args: { body: SECRET_ARG } },
        ctx({ agentId: 'boo-1', teamId: 'team-1', connectorId: CONNECTOR }),
        { registry, approvalPollMs: 5, approvalTimeoutMs: 5_000 },
      )

    const first = call()
    const id = await waitForPending()
    resolveApproval(db, id, 'allow_always')
    expect((await first).ok).toBe(true)

    // The Always minted a standing rule, and the rule answers the next call
    // before any approval row exists: no row, so nothing to announce.
    expect((await call()).ok).toBe(true)

    const events = approvalEvents()
    expect(events.map((e) => [e.kind, e.data['decision'] ?? null])).toEqual([
      ['approval_requested', null],
      ['approval_resolved', 'allow_always'],
    ])
    expect(events[0]).toMatchObject({
      agentId: 'boo-1',
      teamId: 'team-1',
      data: {
        approvalId: id,
        kind: 'tool',
        toolName: 'gh_comment',
        grantId: grant.id,
        connectorId: CONNECTOR,
      },
    })
    const raw = listEvents(db, { kinds: ['approval_requested', 'approval_resolved'] })
    expect(raw.every((e) => !e.data.includes(SECRET_ARG))).toBe(true)
  })

  it('expires and announces the card of a call nobody answered', async () => {
    upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'boo-1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      mode: 'write',
      approvalPolicy: 'risk',
    })
    const registry = new ToolRegistry()
    registry.register({
      name: 'gh_comment',
      description: 'Comment on an issue.',
      inputSchema: z.object({ body: z.string() }),
      owner: 'mcp',
      readOnly: false,
      risk: 'external',
      executor: () => 'ok',
    })

    const result = await executeBrokeredCall(
      db,
      { name: 'gh_comment', args: { body: 'hi' } },
      ctx({ agentId: 'boo-1', teamId: 'team-1', connectorId: CONNECTOR }),
      { registry, approvalPollMs: 5, approvalTimeoutMs: 30 },
    )

    expect(result.denied).toBe('approval:timeout')
    expect(listPendingApprovals(db)).toEqual([])
    const events = approvalEvents()
    const approvalId = events[0]?.data['approvalId'] as string
    expect(getApproval(db, approvalId)?.status).toBe('expired')
    expect(events.map((e) => [e.kind, e.data['decision'] ?? null])).toEqual([
      ['approval_requested', null],
      ['approval_resolved', 'expired'],
    ])
  })
})
