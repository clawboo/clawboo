// The scope gate lives on the SERVER. The browser decides which tiles show a
// Connect button, but a route that trusted that would be trusting the client to
// enforce the permission it is asking for.

import { describe, expect, it } from 'vitest'

import { CONNECTOR_DEFINITIONS, connectorBySlug } from '@clawboo/connector-catalog'

import { connectRefusal } from '../connectors'

describe('connectRefusal', () => {
  it('allows exactly the entries this release can actually run', () => {
    const connectable = CONNECTOR_DEFINITIONS.filter((d) => connectRefusal(d) === null)
    // Every one is curated, stdio, credential-free, and free of placeholder args.
    for (const d of connectable) {
      expect(d.provenance).toBe('curated')
      expect(d.launch.transport).toBe('stdio')
      expect(d.auth.kind).toBe('none')
    }
    // And there is at least one, or the feature ships unreachable.
    expect(connectable.length).toBeGreaterThan(0)
  })

  it('refuses a REMOTE connector, naming the actual obstacle', () => {
    const github = connectorBySlug('github')
    expect(github?.launch.transport).toBe('streamable-http')
    expect(connectRefusal(github!)).toMatch(/OAuth/i)
  })

  it('refuses a connector that needs a credential', () => {
    const notion = connectorBySlug('notion')
    expect(notion?.auth.kind).toBe('api-key')
    expect(connectRefusal(notion!)).toMatch(/credential/i)
  })

  it('refuses FILESYSTEM, because its committed args carry a placeholder path', () => {
    // The catalog's own comment records that this server throws during
    // initialization without a real directory. Offering Connect for it would
    // burn a cold npx install and then fail at the handshake.
    const fs = connectorBySlug('filesystem')
    expect(connectRefusal(fs!)).toMatch(/path you have to fill in/i)
  })

  it('allows the memory connector, which is the one with nothing to fill in', () => {
    expect(connectRefusal(connectorBySlug('memory')!)).toBeNull()
  })
})
