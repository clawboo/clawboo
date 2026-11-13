// An agent's browser profile never saves a password: one Clawboo fills, or one
// a person types while they have taken over, would otherwise be kept in the
// profile, readable by every process of the user that runs the browser.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { keepPasswordsOutOfProfile } from '../agentBrowsers'

let dir: string
const prefsOf = () =>
  JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8')) as Record<
    string,
    unknown
  >

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-profile-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('keepPasswordsOutOfProfile', () => {
  it('turns the password manager off in a new profile', async () => {
    await keepPasswordsOutOfProfile(dir, false)
    expect(prefsOf()).toEqual({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
    })
    expect(fs.statSync(path.join(dir, 'Default', 'Preferences')).mode & 0o777).toBe(0o600)
  })

  it('keeps everything else a profile has set', async () => {
    fs.mkdirSync(path.join(dir, 'Default'))
    fs.writeFileSync(
      path.join(dir, 'Default', 'Preferences'),
      JSON.stringify({
        credentials_enable_service: true,
        profile: { name: 'Person 1', password_manager_enabled: true },
        browser: { window_placement: { maximized: true } },
      }),
    )
    await keepPasswordsOutOfProfile(dir, false)
    expect(prefsOf()).toEqual({
      credentials_enable_service: false,
      profile: { name: 'Person 1', password_manager_enabled: false },
      browser: { window_placement: { maximized: true } },
    })
  })

  it('leaves a file it cannot read as JSON for Chrome, and never throws', async () => {
    fs.mkdirSync(path.join(dir, 'Default'))
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{not json')
    await expect(keepPasswordsOutOfProfile(dir, false)).resolves.toBeUndefined()
    expect(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8')).toBe('{not json')
  })
})
