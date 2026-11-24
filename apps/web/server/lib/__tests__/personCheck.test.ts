// The person check's mode: how it is resolved at startup, what it means for the
// Gateway WebSocket, and what the startup log says it stops.

// Loading the setting from the operator settings is in
// proxyIdentity/__tests__/config.test.ts, which keeps its own settings folder.

import { afterEach, describe, expect, it } from 'vitest'

import {
  controlClaimRequired,
  personCheckLogLine,
  personCheckMode,
  resetPersonCheckForTests,
  resolvePersonCheck,
  setControlClaimMode,
  setPersonCheckMode,
  upgradeAllowedForPersonCheck,
} from '../personCheck'

afterEach(() => resetPersonCheckForTests())

describe('resolvePersonCheck', () => {
  it('keeps page, the default, with any lane', () => {
    for (const lane of [null, 'on'] as const) {
      expect(resolvePersonCheck('page', lane)).toEqual({ ok: true, mode: 'page' })
    }
  })

  it('takes verified behind a sign-in proxy lane that is on', () => {
    expect(resolvePersonCheck('verified', 'on')).toEqual({ ok: true, mode: 'verified' })
  })

  it('makes a required lane verified whatever the setting says', () => {
    expect(resolvePersonCheck('page', 'required')).toEqual({ ok: true, mode: 'verified' })
    expect(resolvePersonCheck('verified', 'required')).toEqual({ ok: true, mode: 'verified' })
  })

  it('refuses verified with no sign-in proxy lane, and says what to set', () => {
    const resolved = resolvePersonCheck('verified', null)
    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.error).toMatch(
      /personCheck is verified but .*proxyIdentity.* is off/,
    )
  })
})

describe('the modes as the server runs them', () => {
  it('is page until startup sets it, and then what startup set', () => {
    expect(personCheckMode()).toBe('page')
    setPersonCheckMode('verified')
    expect(personCheckMode()).toBe('verified')
  })

  it('needs no take-over claim until startup says so', () => {
    expect(controlClaimRequired()).toBe(false)
    setControlClaimMode('required')
    expect(controlClaimRequired()).toBe(true)
    resetPersonCheckForTests()
    expect(controlClaimRequired()).toBe(false)
  })
})

describe('upgradeAllowedForPersonCheck (the Gateway WebSocket)', () => {
  const ADA = { id: 'user-42', name: 'Ada', role: null }

  it('page: opens as before, person or not', () => {
    expect(upgradeAllowedForPersonCheck('page', { person: null })).toBe(true)
    expect(upgradeAllowedForPersonCheck('page', null)).toBe(true)
  })

  it('verified: only a person the lane verified opens it', () => {
    expect(upgradeAllowedForPersonCheck('verified', { person: ADA })).toBe(true)
    expect(upgradeAllowedForPersonCheck('verified', { person: null })).toBe(false)
    expect(upgradeAllowedForPersonCheck('verified', null)).toBe(false)
  })
})

describe('personCheckLogLine', () => {
  it('says what the check stops with agents where they run', () => {
    expect(personCheckLogLine('page', 'none')).toMatch(/Anything holding the access token/)
    // OpenClaw agents run as the server's user in every isolation mode.
    expect(personCheckLogLine('verified', 'agent-users')).toMatch(/OpenClaw agents still run/)
    expect(personCheckLogLine('verified', 'agent-user')).toMatch(/OpenClaw agents still run/)
    expect(personCheckLogLine('verified', 'none')).toMatch(/CLAWBOO_AGENT_USERS/)
  })
})
