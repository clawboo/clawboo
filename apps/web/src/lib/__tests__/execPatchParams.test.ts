// `sessions.patch` used to carry the session's exec posture as
// `{ execHost, execSecurity, execAsk }`. OpenClaw 2026.9 RETIRED two of those
// three. They remain in the protocol v4 schema, so they look accepted, but any
// request carrying either (including `null`) is refused:
//
//   execSecurity/execAsk are retired; set permissionMode
//   (read-only|guarded|workspace|full) instead, or use /exec for this run only.
//
// That is an INVALID_REQUEST, and it fails the WHOLE patch. Three call sites sent
// it: the Permissions tab, the approval followup, and (the one that made this
// look like "chat is broken" rather than "a setting did not save") every chat
// send, which re-applied the agent's exec config before dispatching the message
// and raised "Failed to apply execution permissions" on each one.
//
// Measured against a real 2026.9.2 Gateway: `execHost` alone still succeeds, and
// so does `permissionMode`. These assertions pin the request shape, because the
// failure is invisible in types and only shows up against a live Gateway.

import { describe, expect, it } from 'vitest'

import { resolveExecPatchParams } from '../execSettingsForGateway'

describe('resolveExecPatchParams', () => {
  it('never sends the retired execSecurity field', () => {
    expect(resolveExecPatchParams()).not.toHaveProperty('execSecurity')
  })

  it('never sends the retired execAsk field', () => {
    // Not even as null: the Gateway rejects the key's presence, not its value.
    expect(resolveExecPatchParams()).not.toHaveProperty('execAsk')
  })

  it('still sends execHost, which survived the retirement', () => {
    expect(resolveExecPatchParams()).toEqual({ execHost: 'gateway' })
  })

  it('does not reach for permissionMode as a replacement', () => {
    // `permissionMode` is NOT the equivalent of the old exec pair: it also sets
    // the session's filesystem boundary, so mapping the three exec choices onto
    // it would silently confine (or unconfine) what every agent can read and
    // write. The exec posture lives in the per-agent approvals policy instead.
    expect(resolveExecPatchParams()).not.toHaveProperty('permissionMode')
  })
})
