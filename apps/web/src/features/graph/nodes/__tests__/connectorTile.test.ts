import { describe, expect, it } from 'vitest'

import { connectorSlugFromId, isRemoteConnector } from '../connectorTile'

describe('connectorSlugFromId', () => {
  it('recovers the slug for a connector clawboo owns', () => {
    expect(connectorSlugFromId('conn:connector:clawboo-native:mcp:memory')).toBe('memory')
    expect(connectorSlugFromId('conn:connector:clawboo-native:mcp:filesystem')).toBe('filesystem')
  })

  it('REFUSES an id from any other source', () => {
    // The bug this guards. Every runtime emits connector ids in the same shape
    // for servers IT attached, and the last segment of one of those is a server
    // name, not a catalog slug. Acting on it would send a disconnect at a
    // connector that does not exist, from a button labelled "Turn off".
    expect(connectorSlugFromId('conn:native:clawboo-native:mcp:tools')).toBeNull()
    expect(connectorSlugFromId('conn:codex:codex:mcp:clawboo-memory')).toBeNull()
    expect(connectorSlugFromId('conn:claude-code:claude-code:mcp:clawboo-tasks')).toBeNull()
  })

  it('is null for a tile with no connector at all', () => {
    expect(connectorSlugFromId(null)).toBeNull()
    expect(connectorSlugFromId(undefined)).toBeNull()
    expect(connectorSlugFromId('')).toBeNull()
  })
})

describe('isRemoteConnector', () => {
  it('separates a child process from an HTTP session', () => {
    // Decides only what the toast may claim was stopped.
    expect(isRemoteConnector('memory')).toBe(false)
    expect(isRemoteConnector('linear')).toBe(true)
    expect(isRemoteConnector(null)).toBe(false)
  })

  it('calls an UNKNOWN slug local, because a custom connector is not in the catalog', () => {
    // `connectorBySlug` returns undefined for a connector the operator added, and
    // `undefined?.launch.transport !== 'stdio'` is true. Every custom connector
    // was therefore called remote, so turning one off claimed a session had
    // closed while a child process on the machine was being killed.
    expect(isRemoteConnector('a-connector-the-operator-added')).toBe(false)
    expect(isRemoteConnector('')).toBe(false)
  })
})
