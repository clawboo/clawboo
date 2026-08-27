import { describe, expect, it } from 'vitest'

import { connectorBrandSlug, connectorSlugFromId, isRemoteConnector } from '../connectorTile'

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

describe('connectorBrandSlug', () => {
  // The catalog is the filter in production. Here it is explicit, so these say
  // what the rule is rather than what the current catalog happens to contain.
  const marks = new Set(['github', 'notion', 'gmail', 'linear', 'memory'])
  const has = (slug: string): boolean => marks.has(slug)

  it('draws the logo for a connector clawboo dialled itself', () => {
    expect(connectorBrandSlug('conn:connector:native:mcp:github', has)).toBe('github')
  })

  it('draws the logo for a server a RUNTIME attached', () => {
    // This is the case connectorSlugFromId refuses, deliberately: acting on it
    // would be wrong, drawing it is right.
    expect(connectorSlugFromId('conn:codex:codex:mcp:github')).toBeNull()
    expect(connectorBrandSlug('conn:codex:codex:mcp:github', has)).toBe('github')
  })

  it('strips a runtime prefix only when the catalog recognises the remainder', () => {
    expect(connectorBrandSlug('conn:openclaw:openclaw:mcp:clawboo-memory', has)).toBe('memory')
    expect(connectorBrandSlug('conn:openclaw:openclaw:mcp:clawboo-teamchat', has)).toBeNull()
  })

  it('refuses a segment that is not a connector', () => {
    // `tools` is the exact shape that made the acting resolver dangerous.
    expect(connectorBrandSlug('conn:native:clawboo-native:mcp:tools', has)).toBeNull()
    expect(connectorBrandSlug('conn:native:clawboo-native:mcp:teamchat', has)).toBeNull()
  })

  it('falls back to the server name when the id carries nothing usable', () => {
    expect(connectorBrandSlug('conn:hermes:hermes:mcp:srv1', has, 'Notion')).toBe('notion')
  })

  it('returns null rather than guessing', () => {
    expect(connectorBrandSlug(null, has)).toBeNull()
    expect(connectorBrandSlug(undefined, has, undefined)).toBeNull()
    expect(connectorBrandSlug('conn:hermes:hermes:mcp:srv1', has, 'Some Vendor')).toBeNull()
  })

  it('never returns a slug the caller has no mark for', () => {
    const none = (): boolean => false
    expect(connectorBrandSlug('conn:connector:native:mcp:github', none, 'GitHub')).toBeNull()
  })
})
