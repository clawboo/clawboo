// A REVOKED grant must not authorise the app it was revoked from.
//
// `listCandidateGrants` is a pure subject-by-capability query with no state
// filter, so it returns revoked and suspended rows alongside active ones. The
// main gate is safe because `decideGrant` denies on state, but the two per-app
// checks read those rows DIRECTLY and used to count them. On a real install that
// meant the retired fleet-wide Gmail grant, deliberately revoked, still let
// every agent reach Gmail: the exact access the retirement was written to kill,
// resurrected through the row that killed it.

import { createDb, type ClawbooDb } from '../../db'
import { beforeEach, describe, expect, it } from 'vitest'

import { revokeGrant, upsertGrant } from '../../grants/repository'
import { grantedBrokeredToolkits } from '../grantVisibility'

const CONNECTOR = 'conn:connector:clawboo-native:mcp:composio'
const GMAIL = `${CONNECTOR}:app:gmail`

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const granted = (agentId: string | null) =>
  grantedBrokeredToolkits(db, CONNECTOR, { agentId }, ['gmail', 'googlesheets'])

describe('per-app grant state', () => {
  it('names an app whose grant is active', () => {
    upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: GMAIL,
      capabilityId: null,
      mode: 'write',
      approvalPolicy: 'risk',
      origin: 'operator',
    })
    expect(granted('a1')).toEqual(['gmail'])
  })

  it('does NOT name an app whose grant was revoked', () => {
    const row = upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: GMAIL,
      capabilityId: null,
      mode: 'write',
      approvalPolicy: 'risk',
      origin: 'operator',
    })
    revokeGrant(db, row.id, 'no longer wanted')
    expect(granted('a1')).toEqual([])
  })

  it('a revoked FLEET-WIDE grant authorises nobody, not even an unbound caller', () => {
    // The live shape that made this urgent: subject `global`, id NULL, revoked by
    // the retirement sweep. An unbound session (every OpenClaw agent) matches
    // only global rows, so counting them handed the whole fleet Gmail back.
    const row = upsertGrant(db, {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId: GMAIL,
      capabilityId: null,
      mode: 'admin',
      approvalPolicy: 'risk',
      origin: 'owner',
    })
    revokeGrant(db, row.id, 'connector access is granted per agent')
    expect(granted(null)).toEqual([])
    expect(granted('some-other-agent')).toEqual([])
  })
})
