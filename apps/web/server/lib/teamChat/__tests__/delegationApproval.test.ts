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
  createDb,
  listPendingApprovals,
  resolveApproval,
  type ClawbooDb,
} from '@clawboo/db'

import { resolveDelegationApproval } from '../../../api/delegationApproval'
import { getDbPath } from '../../db'
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
    db = createDb(getDbPath())
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('skips the prompt when the leader has a sticky allow_always for the scope', async () => {
    const seed = createApproval(db, { toolName: 'delegate:code', agentId: 'L', args: {} })
    resolveApproval(db, seed.id, 'allow_always')

    const resolution = await resolveDelegationApproval(db, {
      leaderAgentId: 'L',
      targetAgentName: 'Ops',
      task: 'deploy to production',
    })
    expect(resolution).toBe('allow_always')
    // No NEW pending approval was opened (the sticky path returns early).
    expect(listPendingApprovals(db)).toHaveLength(0)
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

  it('is FAIL-CLOSED: a transport error resolves to timeout (never auto-run)', async () => {
    const broken = createDb(getDbPath())
    broken.$client.close() // any subsequent query throws
    const resolution = await resolveDelegationApproval(broken, {
      leaderAgentId: 'L',
      task: 'deploy to production',
    })
    expect(resolution).toBe('timeout')
  })
})
