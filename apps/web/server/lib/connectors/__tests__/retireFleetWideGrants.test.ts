// Retiring the fleet-wide connector grants an earlier build minted.
//
// The property that matters is the narrow one: only the automatically-minted
// connector grants go. A fleet-wide grant a person created on purpose is their
// decision, and a cleanup that quietly overruled it would be its own bug.

import { createDb, ensureOwnerGrant, listGrants, upsertGrant, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { retireFleetWideConnectorGrants } from '../retireFleetWideGrants'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

const CONNECTOR = 'conn:connector:clawboo-native:mcp:fixture'

const active = (connectorId: string) =>
  listGrants(db).filter((g) => g.connectorId === connectorId && g.state === 'active')

describe('retireFleetWideConnectorGrants', () => {
  it('retires the minted fleet-wide connector grant', () => {
    ensureOwnerGrant(db, {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(active(CONNECTOR)).toHaveLength(1)

    expect(retireFleetWideConnectorGrants(db)).toBe(1)
    expect(active(CONNECTOR)).toHaveLength(0)
  })

  it('leaves an agent grant alone', () => {
    ensureOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(retireFleetWideConnectorGrants(db)).toBe(0)
    expect(active(CONNECTOR)).toHaveLength(1)
  })

  it('leaves a fleet-wide grant a person created alone', () => {
    // `origin: 'operator'` is what POST /api/grants writes. Someone may well
    // want a connector available fleet-wide, and this is not entitled to say no.
    upsertGrant(db, {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      mode: 'read',
      approvalPolicy: 'risk',
      origin: 'operator',
    })
    expect(retireFleetWideConnectorGrants(db)).toBe(0)
    expect(active(CONNECTOR)).toHaveLength(1)
  })

  it('runs to nothing the second time', () => {
    ensureOwnerGrant(db, {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
    })
    expect(retireFleetWideConnectorGrants(db)).toBe(1)
    expect(retireFleetWideConnectorGrants(db)).toBe(0)
  })
})
