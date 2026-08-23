// The grant repository, and the one property the whole design rests on: the
// graph's preview and the broker's gate reach the same verdict because they run
// the same `decideGrant` over the same rows.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { decideGrant } from '@clawboo/governance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { grantKey, normalizeGrantIdentity, ruleKey } from '../key'
import { previewGrant } from '../preview'
import { callsInWindow, chargeCall, releaseCall, resetRateWindows } from '../rateWindow'
import {
  ensureOwnerGrant,
  getGrant,
  lastUsedByGrant,
  listCandidateGrants,
  mintStandingRule,
  reinstateOwnerGrant,
  resumeGrant,
  revokeGrant,
  RESUME_WINDOW_MS,
  sweepExpiredGrants,
  upsertGrant,
  listStandingRules,
} from '../repository'

const CONNECTOR = 'conn:native:clawboo-native:mcp:github'

function agentGrant(db: ClawbooDb, agentId: string, over = {}) {
  return upsertGrant(db, {
    subjectKind: 'agent',
    subjectId: agentId,
    capabilityKind: 'connector',
    connectorId: CONNECTOR,
    capabilityId: null,
    ...over,
  })
}

describe('grant keys', () => {
  it('drops capabilityId when a connectorId is present', () => {
    // A capabilities.id folds the OWNING agent into its key, so a grant keyed on
    // one would be findable by the granter and invisible to the grantee.
    const n = normalizeGrantIdentity({
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: 'c1',
      capabilityId: 'native:mcp:x',
    })
    expect(n.capabilityId).toBeNull()
    expect(n.connectorId).toBe('c1')
  })

  it('cannot be forged by a separator in a component', () => {
    const forged = grantKey({
      subjectKind: 'agent',
      subjectId: 'a|connector|evil',
      capabilityKind: 'connector',
      connectorId: 'c1',
      capabilityId: null,
    })
    const real = grantKey({
      subjectKind: 'agent',
      subjectId: 'a',
      capabilityKind: 'connector',
      connectorId: 'c1',
      capabilityId: null,
    })
    expect(forged).not.toBe(real)
  })

  it('distinguishes a null args shape from an empty one', () => {
    expect(ruleKey('g', 't', null)).not.toBe(ruleKey('g', 't', ''))
  })
})

describe('grant repository', () => {
  let dir: string
  let db: ClawbooDb

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-grants-'))
    db = createDb(path.join(dir, 'test.db'))
    resetRateWindows()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('upserts one row per identity, not one per POST', () => {
    const a = agentGrant(db, 'a1')
    const b = agentGrant(db, 'a1', { mode: 'admin' })
    expect(b.id).toBe(a.id)
    expect(b.mode).toBe('admin')
  })

  it('does NOT clear a time-box or a ceiling the client omitted', () => {
    // The shipped client sends neither field. A blanket update set would silently
    // widen an operator's grant every time anyone re-shared the connector.
    const first = agentGrant(db, 'a1', { expiresAt: 9_999_999_999_999, callCeilingPerHour: 10 })
    expect(first.expiresAt).toBe(9_999_999_999_999)

    const second = agentGrant(db, 'a1', { mode: 'write' })
    expect(second.expiresAt).toBe(9_999_999_999_999)
    expect(second.callCeilingPerHour).toBe(10)
    expect(second.mode).toBe('write')
  })

  it('finds agent, team and global candidates for the same connector', () => {
    agentGrant(db, 'a1')
    upsertGrant(db, {
      subjectKind: 'team',
      subjectId: 't1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    upsertGrant(db, {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })

    const found = listCandidateGrants(db, { agentId: 'a1', teamId: 't1', connectorId: CONNECTOR })
    expect(found.map((g) => g.subjectKind).sort()).toEqual(['agent', 'global', 'team'])
  })

  it('returns NOTHING when the filter names no capability', () => {
    agentGrant(db, 'a1')
    // A caller with no identity is asking a question with no safe answer, and an
    // empty list reads as `deny: no-grant`, which is the right one.
    expect(listCandidateGrants(db, { agentId: 'a1' })).toEqual([])
  })

  it('matches a global grant despite its NULL subject_id', () => {
    upsertGrant(db, {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    // SQLite never matches NULL with `=`, so this needs an IS NULL. Without it an
    // HTTP-attached runtime silently loses its only candidate.
    expect(listCandidateGrants(db, { connectorId: CONNECTOR })).toHaveLength(1)
  })

  it('mints an owner grant once and never resurrects a revoked one', () => {
    const first = ensureOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(first?.origin).toBe('owner')
    expect(first?.mode).toBe('admin')

    revokeGrant(db, first!.id, 'detached')

    // The projection re-runs on every inventory read. An update here would undo
    // the operator's revoke on the very next refresh.
    const second = ensureOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(second).toBeNull()
    expect(getGrant(db, first!.id)?.state).toBe('revoked')
  })

  it('promotes an owner grant to operator when a human deliberately shares it', () => {
    // Sharing a connector the grantee's runtime ALREADY attaches lands on that
    // agent's existing owner row. Without the promotion the row reactivates,
    // the POST reports success, and the operator can neither see the edge nor
    // detach it, because only an operator grant is drawn.
    const owner = ensureOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(owner?.origin).toBe('owner')

    const shared = agentGrant(db, 'a1', { origin: 'operator', mode: 'write' })
    expect(shared.id).toBe(owner!.id)
    expect(shared.origin).toBe('operator')
  })

  it('never demotes an operator grant back to owner', () => {
    const op = agentGrant(db, 'a1', { origin: 'operator' })
    ensureOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(getGrant(db, op.id)?.origin).toBe('operator')
  })

  it('returns the PERSISTED standing rule on conflict, not a fresh id', () => {
    const g = agentGrant(db, 'a1')
    const first = mintStandingRule(db, {
      grantId: g.id,
      toolName: 'read_file',
      argsShape: null,
      decision: 'allow',
      expiresAt: Date.now() + 60_000,
    })
    const second = mintStandingRule(db, {
      grantId: g.id,
      toolName: 'read_file',
      argsShape: null,
      decision: 'deny',
      expiresAt: Date.now() + 60_000,
    })
    // The UNIQUE index keeps the existing row, so returning the id we just
    // generated would hand the caller a key no row has and any audit
    // attribution written from it would dangle.
    expect(second.id).toBe(first.id)
    expect(second.decision).toBe('deny')
    expect(listStandingRules(db, g.id)).toHaveLength(1)
  })

  it('an explicit reinstate recovers a revoked owner grant; the automatic path never does', () => {
    // Insert-only with no counterpart makes a revoked owner grant PERMANENT: the
    // key has no state component, so every later ensure returns null while the
    // gate keeps denying grant-revoked. The two paths have to differ.
    const owner = ensureOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })!
    revokeGrant(db, owner.id, 'disconnected')

    const identity = {
      subjectKind: 'agent' as const,
      subjectId: 'a1',
      capabilityKind: 'connector' as const,
      connectorId: CONNECTOR,
      capabilityId: null,
    }
    // The projection runs on every read and must NOT bring it back.
    expect(ensureOwnerGrant(db, identity)).toBeNull()
    expect(getGrant(db, owner.id)?.state).toBe('revoked')

    // An explicit reconnect must, and re-pins while it is at it.
    const back = reinstateOwnerGrant(db, { ...identity, toolsHashPin: 'newhash' })
    expect(back?.state).toBe('active')
    expect(back?.id).toBe(owner.id)
    expect(getGrant(db, owner.id)?.toolsHashPin).toBe('newhash')
  })

  it('reinstate REFUSES a revoked operator grant', () => {
    // Revoking a deliberate share is a deliberate decision. Reinstating it
    // because someone reconnected the underlying connector would silently undo
    // that decision, which is the bypass this check exists to prevent.
    const op = agentGrant(db, 'a1', { origin: 'operator' })
    revokeGrant(db, op.id, 'detached')

    const out = reinstateOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(out?.state).toBe('revoked')
    expect(getGrant(db, op.id)?.state).toBe('revoked')
  })

  it('reinstate leaves a SUSPENDED grant alone', () => {
    // Suspended is off for a reason the caller has not addressed. Clearing it
    // silently would be exactly the resurrection the split prevents.
    const g = agentGrant(db, 'a1')
    db.$client.prepare("UPDATE capability_grants SET state = 'suspended' WHERE id = ?").run(g.id)
    const out = reinstateOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(out?.state).toBe('suspended')
  })

  it('cascade-deletes standing rules on revoke', () => {
    const g = agentGrant(db, 'a1')
    mintStandingRule(db, {
      grantId: g.id,
      toolName: 'read_file',
      argsShape: null,
      decision: 'allow',
      expiresAt: Date.now() + 60_000,
    })
    expect(listStandingRules(db, g.id)).toHaveLength(1)

    revokeGrant(db, g.id, null)
    // A remembered "Always" outliving its grant would let a re-grant inherit
    // approvals the operator gave under different circumstances.
    expect(listStandingRules(db, g.id)).toHaveLength(0)
  })

  it('resumes inside the undo window and refuses outside it', () => {
    const g = agentGrant(db, 'a1')
    revokeGrant(db, g.id, null)
    expect(getGrant(db, g.id)?.state).toBe('revoked')

    expect(resumeGrant(db, g.id)?.state).toBe('active')

    revokeGrant(db, g.id, null)
    const late = resumeGrant(db, g.id, Date.now() + RESUME_WINDOW_MS + 1)
    expect(late).toBeNull()
    expect(getGrant(db, g.id)?.state).toBe('revoked')
  })

  it('never resumes an EXPIRED grant', () => {
    // Expiry is not a decision anyone is undoing.
    const g = agentGrant(db, 'a1', { expiresAt: Date.now() - 1 })
    sweepExpiredGrants(db)
    expect(getGrant(db, g.id)?.state).toBe('expired')
    expect(resumeGrant(db, g.id)).toBeNull()
  })

  it('sweeps past-expiry grants and rules', () => {
    const live = agentGrant(db, 'a1', { expiresAt: Date.now() + 60_000 })
    const dead = upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a2',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      expiresAt: Date.now() - 1,
    })
    mintStandingRule(db, {
      grantId: live.id,
      toolName: 't',
      argsShape: null,
      decision: 'allow',
      expiresAt: Date.now() - 1,
    })

    const swept = sweepExpiredGrants(db)
    expect(swept.grants).toBe(1)
    expect(swept.rules).toBe(1)
    expect(getGrant(db, dead.id)?.state).toBe('expired')
    expect(getGrant(db, live.id)?.state).toBe('active')
  })

  it('derives lastUsed from the audit table rather than a hot column', () => {
    const g = agentGrant(db, 'a1')
    expect(lastUsedByGrant(db, [g.id]).size).toBe(0)
  })
})

describe('the rate window', () => {
  beforeEach(() => resetRateWindows())

  it('counts, releases, and forgets anything older than an hour', () => {
    const now = Date.now()
    chargeCall('g1', now)
    chargeCall('g1', now)
    expect(callsInWindow('g1', now)).toBe(2)

    releaseCall('g1', now)
    expect(callsInWindow('g1', now)).toBe(1)

    expect(callsInWindow('g1', now + 60 * 60_000 + 1)).toBe(0)
  })
})

describe('preview and gate agree', () => {
  let dir: string
  let db: ClawbooDb

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-preview-'))
    db = createDb(path.join(dir, 'test.db'))
    resetRateWindows()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('previews an active grant as active', () => {
    const g = agentGrant(db, 'a1', { mode: 'admin' })
    const p = previewGrant({
      grants: listCandidateGrants(db, { agentId: 'a1', connectorId: CONNECTOR }),
      now: Date.now(),
    })
    expect(p).toEqual({ grantId: g.id, state: 'active', mode: 'admin', denyReason: null })
  })

  it('previews a revoked grant as revoked, from the SAME verdict the gate reaches', () => {
    const g = agentGrant(db, 'a1')
    revokeGrant(db, g.id, null)
    const candidates = listCandidateGrants(db, { agentId: 'a1', connectorId: CONNECTOR })

    const preview = previewGrant({ grants: candidates, now: Date.now() })
    const gate = decideGrant({
      grants: candidates,
      tool: { name: '*', readOnly: true },
      now: Date.now(),
    })

    expect(preview?.state).toBe('revoked')
    expect(preview?.denyReason).toBe('grant-revoked')
    // The coupling, asserted rather than described: the badge is the gate.
    expect(gate.kind).toBe('deny')
    if (gate.kind === 'deny') expect(gate.reason).toBe(preview?.denyReason)
  })

  it('previews an expired-but-unswept row as expired', () => {
    // row.state is still `active`; decideGrant denies on the timestamp. The
    // operator sees what the runtime would do, not what the column happens to say.
    agentGrant(db, 'a1', { expiresAt: Date.now() - 1 })
    const p = previewGrant({
      grants: listCandidateGrants(db, { agentId: 'a1', connectorId: CONNECTOR }),
      now: Date.now(),
    })
    expect(p?.state).toBe('expired')
    expect(p?.denyReason).toBe('grant-expired')
  })

  it('previews drift when the live spec hash differs from the pin', () => {
    agentGrant(db, 'a1', { specHashPin: 'aaa' })
    const p = previewGrant({
      grants: listCandidateGrants(db, { agentId: 'a1', connectorId: CONNECTOR }),
      currentSpecHash: 'bbb',
      now: Date.now(),
    })
    expect(p?.denyReason).toBe('spec-drift')
  })

  it('returns null when nothing could authorize the call', () => {
    expect(previewGrant({ grants: [], now: Date.now() })).toBeNull()
  })
})
