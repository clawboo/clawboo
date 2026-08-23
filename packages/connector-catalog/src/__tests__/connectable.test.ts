// ONE definition of "can this be connected", shared by the REST handler that
// enforces it and the browser that renders it. A client-side copy would drift,
// and the first symptom would be a tile offering a button the server refuses.

import { describe, expect, it } from 'vitest'

import { CONNECTOR_DEFINITIONS, connectorBySlug } from '../index'
import { connectRefusal, isConnectable, isReachable, needsSignInOnly } from '../connectable'

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
    const linear = connectorBySlug('linear')
    expect(linear?.launch.transport).toBe('streamable-http')
    expect(connectRefusal(linear!)).toBe('remote-needs-oauth')
  })

  it('refuses GITHUB permanently, because clawboo cannot register itself there', () => {
    // Verified against the live provider: its authorization server publishes no
    // registration endpoint. clawboo ships no OAuth app and no client secret, so
    // a Sign in button for it would fail three requests into the flow every
    // time. The refusal has to be terminal rather than "sign in first".
    const github = connectorBySlug('github')!
    expect(github.auth.needsPreregisteredApp).toBe(true)
    expect(connectRefusal(github, true, true, false)).toBe('remote-needs-registered-app')
    // Even a stored token does not clear it: there is no way to have obtained one.
    expect(connectRefusal(github, true, true, true)).toBe('remote-needs-registered-app')
    expect(isReachable(github)).toBe(false)
  })

  it('refuses a connector that needs a credential', () => {
    const notion = connectorBySlug('notion')
    expect(notion?.auth.kind).toBe('api-key')
    expect(connectRefusal(notion!)).toBe('needs-credential')
  })

  it('refuses FILESYSTEM, because its committed args carry a placeholder path', () => {
    // The catalog's own comment records that this server throws during
    // initialization without a real directory. Offering Connect for it would
    // burn a cold npx install and then fail at the handshake.
    const fs = connectorBySlug('filesystem')
    expect(connectRefusal(fs!)).toBe('needs-user-supplied-argument')
  })

  it('refuses SQLITE, which needs a database path the catalog does not pass', () => {
    // Verified by running it: exits 1 with `Usage: mcp-server-sqlite-npx
    // <database-path>`. Its args look ordinary, which is why the placeholder
    // pattern misses it and the flag has to be declared.
    expect(connectRefusal(connectorBySlug('sqlite')!)).toBe('needs-user-supplied-argument')
  })

  it('does not crash on a REMOTE entry, which carries no launch args', () => {
    // The placeholder backstop reads `launch.args`, which only a stdio launch
    // has. It used to be unreachable for a remote because the sign-in check
    // returned first; making that solvable made this reachable.
    const linear = connectorBySlug('linear')!
    expect(() => connectRefusal(linear, true, true, true)).not.toThrow()
    expect(connectRefusal(linear, true, true, true)).toBeNull()
  })

  it('treats a remote connector as connectable ONCE signed in', () => {
    const linear = connectorBySlug('linear')!
    expect(connectRefusal(linear, true, true, false)).toBe('remote-needs-oauth')
    expect(connectRefusal(linear, true, true, true)).toBeNull()
    expect(needsSignInOnly(linear)).toBe(true)
    // And the one that cannot be signed into is not offered the affordance.
    expect(needsSignInOnly(connectorBySlug('github')!)).toBe(false)
  })

  it('allows the memory connector, which is the one with nothing to fill in', () => {
    expect(connectRefusal(connectorBySlug('memory')!)).toBeNull()
    expect(isConnectable(connectorBySlug('memory')!)).toBe(true)
  })
})
