// What clawboo's browser socket ANNOUNCES about itself. Both values below were
// wrong against OpenClaw 2026.9 and both failed silently in types, so they are
// pinned here.
//
// 1. `client.id` used to be `openclaw-control-ui`, i.e. a claim to BE the
//    Gateway's own bundled Control UI. 2026.9 build-checks that exact id: a
//    browser-origin connection claiming it, whose `client.buildId` does not equal
//    the Gateway's, is refused with
//
//      protocol mismatch: Control UI updated; reload this page to continue
//
//    which names a protocol and is not about protocols at all. clawboo is a
//    separate product with no Gateway build id to match, so the check could never
//    pass and the dashboard sat on "No agents yet".
//
// 2. `caps` used to be empty. The Gateway registers an exec-approval route only
//    for connections that declared `exec-approvals`, and a run with no route is
//    not queued for a human, it is denied:
//
//      exec denied: Headless runs cannot wait for interactive exec approval.
//
//    so the agent reported the command as blocked and no card ever appeared.
//
// Both were confirmed against a live 2026.9.2 Gateway, in both directions.

import { describe, expect, it } from 'vitest'

import { GATEWAY_BROWSER_CAPS, GATEWAY_BROWSER_CLIENT_ID } from '../helpers'

describe('GATEWAY_BROWSER_CLIENT_ID', () => {
  it('does NOT claim to be the Gateway Control UI', () => {
    // The whole bug in one assertion.
    expect(GATEWAY_BROWSER_CLIENT_ID).not.toBe('openclaw-control-ui')
  })

  it('is an id the Gateway allowlists', () => {
    // `client.id` is validated against a fixed set; an invented name like
    // `clawboo-web` is rejected with `invalid connect params: at /client/id` and
    // the socket closes 1008. `webchat-ui` is the browser-UI id that is not
    // build-checked.
    expect(GATEWAY_BROWSER_CLIENT_ID).toBe('webchat-ui')
  })
})

describe('GATEWAY_BROWSER_CAPS', () => {
  it('declares exec-approvals, without which approvals are denied, not queued', () => {
    expect(GATEWAY_BROWSER_CAPS).toContain('exec-approvals')
  })

  it('does NOT declare tool-events on browser sockets', () => {
    // That capability pulls full tool arguments across the socket and is declared
    // once, on the single long-lived server-side operator connection. A browser
    // has no reader for it.
    expect(GATEWAY_BROWSER_CAPS).not.toContain('tool-events')
  })
})
