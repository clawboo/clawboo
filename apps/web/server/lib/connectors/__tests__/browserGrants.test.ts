// Granting the browser to every agent, without reopening the hole that was
// closed by removing the fleet-wide grant.
//
// The properties worth pinning are the ones that distinguish this from what was
// removed, and the one that makes a revoke stick. A boot sweep that resurrects a
// revoked grant is worse than no sweep: it silently overrules a person, once per
// restart, and nothing on screen says so.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { listGrants, revokeGrant, upsertConnector, upsertGrant } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../db'
import { ensureBrowserConnectedAtBoot } from '../../../api/connectors'
import {
  browserConnectorIds,
  ensureBrowserGrantsForAgent,
  ensureBrowserGrantsForAllAgents,
} from '../browserGrants'

let home: string
let prevHome: string | undefined

// No agent rows are created: `capability_grants` has no foreign key to `agents`
// (confirmed in the schema), so the grant path never reads that table. Adding
// rows would only couple this test to columns it does not exercise.
const browserGrantsFor = (id: string) =>
  listGrants(getDb(), { subjectId: id }).filter(
    (g) => g.capabilityKind === 'connector' && browserConnectorIds().includes(g.connectorId ?? ''),
  )

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-browsergrant-'))
  prevHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = home
  resetDb()
  getDb()
})

afterEach(async () => {
  resetDb()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('browserConnectorIds', () => {
  it('comes from the catalog, so the set cannot drift from it', () => {
    const ids = browserConnectorIds()
    expect(ids.length).toBeGreaterThanOrEqual(2)
    // Both browser connectors the catalog ships today.
    expect(ids.some((i) => i.endsWith('playwright'))).toBe(true)
    expect(ids.some((i) => i.endsWith('chrome-devtools'))).toBe(true)
  })
})

describe('ensureBrowserGrantsForAgent', () => {
  it('grants every browser connector to a new agent', () => {
    const minted = ensureBrowserGrantsForAgent(getDb(), 'a1')

    expect(minted).toBe(browserConnectorIds().length)
    expect(browserGrantsFor('a1')).toHaveLength(browserConnectorIds().length)
  })

  it('mints a PER-AGENT grant, never a global one', () => {
    // The whole point. A global grant answers for every caller regardless of who
    // asked, which is the escalation that was removed.
    ensureBrowserGrantsForAgent(getDb(), 'a1')

    for (const g of browserGrantsFor('a1')) {
      expect(g.subjectKind).toBe('agent')
      expect(g.subjectId).toBe('a1')
    }
  })

  it('does not grant admin', () => {
    // `write` is the narrowest mode that runs the browser tools. `admin` plus
    // `toolAllow: ['*']` was the shape of the grant that was removed.
    ensureBrowserGrantsForAgent(getDb(), 'a1')

    for (const g of browserGrantsFor('a1')) expect(g.mode).toBe('write')
  })

  it('mints an operator-origin grant, so it can be seen and revoked', () => {
    // An owner-origin grant gates real calls but draws no edge and offers no
    // Detach, and the agent-scoped capabilities read never surfaces it, so the
    // panel would still report no browser after being granted.
    ensureBrowserGrantsForAgent(getDb(), 'a1')

    for (const g of browserGrantsFor('a1')) expect(g.origin).toBe('operator')
  })

  it('is idempotent: a second call mints nothing', () => {
    ensureBrowserGrantsForAgent(getDb(), 'a1')

    expect(ensureBrowserGrantsForAgent(getDb(), 'a1')).toBe(0)
    expect(browserGrantsFor('a1')).toHaveLength(browserConnectorIds().length)
  })

  it('NEVER resurrects a grant an operator revoked', () => {
    // The property that makes this safe to run on every boot. `upsertGrant`
    // unconditionally writes state:'active' and revokedAt:null on update, so a
    // sweep built on it would re-grant a browser the operator took away, once
    // per restart, silently.
    ensureBrowserGrantsForAgent(getDb(), 'a1')
    for (const g of browserGrantsFor('a1')) revokeGrant(getDb(), g.id, 'operator said no')

    const minted = ensureBrowserGrantsForAgent(getDb(), 'a1')

    expect(minted).toBe(0)
    for (const g of browserGrantsFor('a1')) expect(g.state).toBe('revoked')
  })

  it('leaves a narrower grant a human already made alone', () => {
    // A decision exists for this pair; the sweep is not entitled to widen it.
    const connectorId = browserConnectorIds()[0] as string
    upsertGrant(getDb(), {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId,
      capabilityId: null,
      mode: 'read',
      toolAllow: ['browser_snapshot'],
    })

    ensureBrowserGrantsForAgent(getDb(), 'a1')

    const kept = browserGrantsFor('a1').find((g) => g.connectorId === connectorId)
    expect(kept?.mode).toBe('read')
    expect(kept?.toolAllow).toEqual(['browser_snapshot'])
  })
})

describe('ensureBrowserGrantsForAllAgents', () => {
  it('backfills agents that already existed', () => {
    // The path no create-time hook can reach: the onboarding seed, Boo Zero, and
    // the rows the OpenClaw sync mints for agents from someone's Gateway.

    const minted = ensureBrowserGrantsForAllAgents(getDb(), ['a1', 'a2', 'a3'])

    expect(minted).toBe(3 * browserConnectorIds().length)
    for (const id of ['a1', 'a2', 'a3']) {
      expect(browserGrantsFor(id)).toHaveLength(browserConnectorIds().length)
    }
  })

  it('is safe to run on every boot', () => {
    ensureBrowserGrantsForAllAgents(getDb(), ['a1', 'a2'])

    expect(ensureBrowserGrantsForAllAgents(getDb(), ['a1', 'a2'])).toBe(0)
  })
})

describe('ensureBrowserConnectedAtBoot', () => {
  const seedRow = (slug: string, desiredState: 'connected' | 'disconnected') =>
    upsertConnector(getDb(), {
      id: `conn:connector:clawboo-native:mcp:${slug}`,
      slug,
      catalogId: slug,
      displayName: slug,
      transport: 'stdio',
      spec: '{}',
      specHash: 'h',
      toolsHash: 't',
      egressAllow: JSON.stringify(['*']),
      trifecta: JSON.stringify({}),
      health: 'ok',
      healthDetail: null,
      failures: 0,
      tenantId: null,
      desiredState,
    })

  // Every browser is seeded in each case, so the function short-circuits on the
  // row and never spawns a process. A test that let it reach `connectConnector`
  // would download and run an MCP server.
  it('stands down when the operator already CONNECTED the browsers', async () => {
    for (const id of browserConnectorIds()) seedRow(id.split(':').pop() as string, 'connected')
    await expect(ensureBrowserConnectedAtBoot(getDb())).resolves.toBe(0)
  })

  it('stands down when the operator deliberately DISCONNECTED them', async () => {
    // The property that makes auto-connect safe to run on every boot: a
    // Disconnect must survive a restart. The check is on the ROW, not its state,
    // which is what makes this hold.
    for (const id of browserConnectorIds()) seedRow(id.split(':').pop() as string, 'disconnected')
    await expect(ensureBrowserConnectedAtBoot(getDb())).resolves.toBe(0)
  })
})
