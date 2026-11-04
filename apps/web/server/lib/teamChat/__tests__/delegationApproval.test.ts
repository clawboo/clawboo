// The server risky-delegation approval gate: the `isRiskyDelegation` predicate (the
// engine's gate keys on it) + `resolveDelegationApproval` (the engine's
// `requestDelegationApproval` dep). Together they satisfy the acceptance: a risky
// task is gated (predicate true) and, via the DB handshake, SKIPPED on deny/timeout
// (the engine treats those as skip-and-reflect); a routine task is never gated; and
// the resolver is FAIL-CLOSED (a transport error → 'timeout'). The engine's
// skip-and-reflect behavior given a resolution is proven separately by
// `boardOrchestration.contract.test.ts` (which injects its own gate deps).

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createApproval,
  getApproval,
  listEvents,
  listPendingApprovals,
  resolveApproval,
  type ClawbooDb,
} from '@clawboo/db'

import { resolveDelegationApproval } from '../../../api/delegationApproval'
import { getDb, resetDb } from '../../db'
import { isRiskyDelegation, RISKY_DELEGATION_RE } from '../riskyDelegation'

describe('isRiskyDelegation', () => {
  it('flags destructive / irreversible / secret-touching tasks', () => {
    for (const task of [
      'deploy to production',
      'delete the users table',
      'drop table sessions',
      'rotate the api_key for the mailer',
      'force-push the fix to main',
      'publish the release notes',
      'rm -rf ./dist and rebuild',
      'read the credential from the vault',
    ]) {
      expect(isRiskyDelegation({ task })).toBe(true)
    }
  })

  it('does NOT gate routine work', () => {
    for (const task of [
      'summarize the meeting notes',
      'draft an outline for the report',
      'find three sources and cite them',
      'review the pull request for style',
    ]) {
      expect(isRiskyDelegation({ task })).toBe(false)
    }
  })

  it('is case-insensitive and word-boundary anchored', () => {
    expect(RISKY_DELEGATION_RE.test('DEPLOY the app')).toBe(true)
    // The `\b` anchors mean a risky keyword buried mid-word does not trip it
    // ('deploy' inside 'undeployed'). The documented broad-match tradeoff is that a
    // benign task using a whole risky WORD ('publish the draft') still gates.
    expect(isRiskyDelegation({ task: 'undeployed feature flag audit' })).toBe(false)
  })
})

describe('resolveDelegationApproval', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-delegapproval-home-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('asks again after an earlier allow_always: a hand-off is never remembered', async () => {
    const seed = createApproval(db, { toolName: 'delegate:code', agentId: 'L', args: {} })
    resolveApproval(db, seed.id, 'allow_always')

    const pending = resolveDelegationApproval(db, {
      leaderAgentId: 'L',
      targetAgentName: 'Ops',
      task: 'deploy to production',
    })
    const open = listPendingApprovals(db)
    expect(open).toHaveLength(1)
    // The card offers no Always, and an API Always would mint nothing.
    expect(open[0]!.neverRemember).toBe(1)
    resolveApproval(db, open[0]!.id, 'allow_always')
    expect(await pending).toBe('allow_always')

    // The next risky hand-off from the same leader asks again.
    const next = resolveDelegationApproval(db, {
      leaderAgentId: 'L',
      targetAgentName: 'Ops',
      task: 'deploy to production',
    })
    expect(listPendingApprovals(db)).toHaveLength(1)
    resolveApproval(db, listPendingApprovals(db)[0]!.id, 'deny')
    expect(await next).toBe('deny')
  })

  it('opens a pending approval and resolves to the leader decision (deny → skip)', async () => {
    const pending = resolveDelegationApproval(db, {
      leaderAgentId: 'L',
      targetAgentId: 'a2',
      targetAgentName: 'Ops',
      task: 'deploy to production',
    })
    // createApproval ran synchronously (before the first await) → the row is present.
    const open = listPendingApprovals(db)
    expect(open).toHaveLength(1)
    resolveApproval(db, open[0]!.id, 'deny')
    expect(await pending).toBe('deny')
  })

  it('announces the hand-off and the leader decision in the event log', async () => {
    // Whatever follows the event log can see a risky hand-off waiting on the
    // leader, and how it was answered. The task text never rides along.
    const pending = resolveDelegationApproval(db, {
      leaderAgentId: 'L',
      targetAgentName: 'Ops',
      task: 'deploy the payroll export to production',
      taskId: 'task-3',
    })
    const [open] = listPendingApprovals(db)
    resolveApproval(db, open!.id, 'allow_once')
    expect(await pending).toBe('allow_once')

    const events = listEvents(db, { kinds: ['approval_requested', 'approval_resolved'] })
    expect(
      events.map((e) => ({
        kind: e.kind,
        agentId: e.agentId,
        taskId: e.taskId,
        data: JSON.parse(e.data) as unknown,
      })),
    ).toEqual([
      {
        kind: 'approval_requested',
        agentId: 'L',
        taskId: 'task-3',
        data: {
          approvalId: open!.id,
          kind: 'tool',
          toolName: 'delegate:code',
          toolClass: null,
          grantId: null,
          connectorId: null,
          expiresAt: open!.expiresAt,
        },
      },
      {
        kind: 'approval_resolved',
        agentId: 'L',
        taskId: 'task-3',
        data: {
          approvalId: open!.id,
          decision: 'allow_once',
          kind: 'tool',
          toolName: 'delegate:code',
        },
      },
    ])
    for (const e of events) expect(e.data).not.toContain('payroll')
  })

  it('expires and announces a hand-off nobody answered as soon as it stops waiting', async () => {
    const pending = resolveDelegationApproval(db, {
      leaderAgentId: 'L',
      targetAgentName: 'Ops',
      task: 'deploy to production',
    })
    const [open] = listPendingApprovals(db)
    db.$client
      .prepare('UPDATE tool_call_approvals SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1_000, open!.id)
    expect(await pending).toBe('expired')

    expect(getApproval(db, open!.id)?.status).toBe('expired')
    const resolved = listEvents(db, { kinds: ['approval_resolved'] })
    expect(resolved.map((e) => JSON.parse(e.data) as unknown)).toEqual([
      { approvalId: open!.id, decision: 'expired', kind: 'tool', toolName: 'delegate:code' },
    ])
  })

  it('is FAIL-CLOSED: a transport error resolves to timeout (never auto-run)', async () => {
    const broken = getDb()
    broken.$client.close() // any subsequent query throws
    const resolution = await resolveDelegationApproval(broken, {
      leaderAgentId: 'L',
      task: 'deploy to production',
    })
    expect(resolution).toBe('timeout')
  })
})
