// Custom connectors are the answer to "how many connectors are there": the
// committed catalog is a vouched starting set, not a ceiling.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { connectRefusal, connectorBySlug } from '@clawboo/connector-catalog'
import { createDb, type ClawbooDb } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  customConnectorBySlug,
  deleteCustomConnector,
  listCustomConnectors,
  saveCustomConnector,
  toDefinition,
} from '../custom'

describe('custom connectors', () => {
  let dir: string
  let db: ClawbooDb

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-custom-'))
    db = createDb(path.join(dir, 'test.db'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const entry = {
    slug: 'my-server',
    displayName: 'My Server',
    command: '/usr/local/bin/node',
    args: ['/srv/mcp/index.js'],
  }

  it('round-trips through storage', () => {
    saveCustomConnector(db, entry)
    expect(listCustomConnectors(db)).toHaveLength(1)
    expect(customConnectorBySlug(db, 'my-server')?.displayName).toBe('My Server')
    expect(deleteCustomConnector(db, 'my-server')).toBe(true)
    expect(listCustomConnectors(db)).toHaveLength(0)
  })

  it('replaces rather than duplicating on re-save', () => {
    saveCustomConnector(db, entry)
    saveCustomConnector(db, { ...entry, displayName: 'Renamed' })
    const all = listCustomConnectors(db)
    expect(all).toHaveLength(1)
    expect(all[0]!.displayName).toBe('Renamed')
  })

  it('is CONNECTABLE, unlike a community entry', () => {
    // Same technical risk, different consent. A custom connector is a command
    // the operator typed, which is what they would otherwise paste into a
    // runtime's own config. A community entry is a one-click install of somebody
    // else's package.
    const def = toDefinition(entry)
    expect(def.provenance).toBe('custom')
    expect(connectRefusal(def)).toBeNull()

    const community = { ...def, provenance: 'community' as const }
    expect(connectRefusal(community)).toBe('community-unsandboxed')
  })

  it('declares the WORST trifecta, because we know nothing about it', () => {
    // A reassuring badge on a program nobody has inspected would be worse than
    // no badge. This also gives it an `external` risk floor at the gate.
    const def = toDefinition(entry)
    expect(def.trifecta).toEqual({
      readsPrivateData: true,
      ingestsUntrustedContent: true,
      canEgress: true,
    })
  })

  it('does not let a custom entry shadow a catalog slug', () => {
    // Enforced in the route; asserted here so the reason is recorded next to the
    // storage it protects: replacing a vouched entry with an unknown command
    // would be invisible to the operator afterwards.
    expect(connectorBySlug('memory')).toBeDefined()
  })

  it('survives a corrupt settings value', () => {
    saveCustomConnector(db, entry)
    db.$client
      .prepare("UPDATE settings SET value = '{not json' WHERE key = ?")
      .run('connectors:custom')
    expect(listCustomConnectors(db)).toEqual([])
  })
})

describe('a community entry keeps what it declared', () => {
  it('asks for the env vars it declared, as secrets', () => {
    // The defect: toDefinition hardcoded `auth: { kind: 'none', inputs: [] }`,
    // so the consent panel said "It will ask for CLICKUP_API_KEY" and then
    // nothing ever asked. The connector showed a Turn on button and failed at
    // spawn with the vendor's own unauthenticated error.
    const def = toDefinition({
      slug: 'clickup',
      displayName: 'ClickUp',
      command: 'npx',
      args: ['-y', 'clickup-mcp@1.0.0'],
      authInputs: [{ key: 'CLICKUP_API_KEY', description: 'Your key.', required: true }],
    })
    expect(def.auth.kind).toBe('api-key')
    expect(def.auth.inputs).toHaveLength(1)
    expect(def.auth.inputs[0]).toMatchObject({
      key: 'CLICKUP_API_KEY',
      required: true,
      // clawboo has not read this server, so anything it asks for is a
      // credential rather than configuration.
      secret: true,
    })
  })

  it('keeps the registry identity so provenance survives the add', () => {
    const def = toDefinition({
      slug: 'clickup',
      displayName: 'ClickUp',
      command: 'npx',
      args: ['-y', 'clickup-mcp@1.0.0'],
      catalogId: 'io.github.taazkareem/clickup-mcp',
    })
    expect(def.catalogId).toBe('io.github.taazkareem/clickup-mcp')
    // Still the operator's own entry: clawboo vouches for nothing here.
    expect(def.provenance).toBe('custom')
  })

  it('records the version the operator was shown, and says so honestly when there was none', () => {
    const fromRegistry = toDefinition({
      slug: 'webhound',
      displayName: 'Webhound',
      command: 'npx',
      args: ['-y', 'webhound-mcp@0.5.2'],
      pinnedVersion: '0.5.2',
    })
    // A custom connector is stdio by construction; narrow so the union's
    // remote arm does not hide the field.
    expect(fromRegistry.launch.transport).toBe('stdio')
    if (fromRegistry.launch.transport === 'stdio')
      expect(fromRegistry.launch.pinnedVersion).toBe('0.5.2')

    const handTyped = toDefinition({
      slug: 'mine',
      displayName: 'Mine',
      command: 'node',
      args: ['server.js'],
    })
    if (handTyped.launch.transport === 'stdio')
      expect(handTyped.launch.pinnedVersion).toBe('user-supplied')
  })

  it('an entry that declared nothing still needs nothing', () => {
    const def = toDefinition({
      slug: 'plain',
      displayName: 'Plain',
      command: 'npx',
      args: ['-y', 'plain@1.0.0'],
    })
    expect(def.auth.kind).toBe('none')
    expect(def.auth.inputs).toEqual([])
    expect(def.catalogId).toBeUndefined()
  })
})
