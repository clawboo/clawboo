// Settings an administrator pins in one file or in the environment: what wins,
// what refuses to start, and that the file is only ever read.

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, resetDb } from '../db'
import {
  OPERATOR_KEYS,
  OperatorSettingsError,
  PinnedSettingError,
  effectiveSetting,
  initOperatorSettings,
  listEffectiveSettings,
  resetOperatorSettings,
  saveUserSetting,
} from '../operatorSettings'

let home: string
const operatorFile = () => path.join(home, 'operator.json')
const writeOperator = (doc: unknown) =>
  writeFileSync(operatorFile(), typeof doc === 'string' ? doc : JSON.stringify(doc))

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-operator-'))
  vi.stubEnv('CLAWBOO_HOME', home)
  // A shell can carry one of these (Claude Code sets ANTHROPIC_BASE_URL), and a
  // pinned variable would change what every test below sees.
  for (const spec of Object.values(OPERATOR_KEYS)) vi.stubEnv(spec.env, '')
  resetOperatorSettings()
  resetDb()
  getDb()
})
afterEach(() => {
  resetDb()
  resetOperatorSettings()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('precedence', () => {
  it('without a file or a variable, every key is its default and nothing is pinned', () => {
    expect(initOperatorSettings()).toEqual({ file: null, pins: {} })
    for (const s of listEffectiveSettings()) {
      expect(s.source).toBe('default')
      expect(s.pinned).toBe(false)
    }
    expect(effectiveSetting('disableSelfUpdate').value).toBe(false)
    expect(effectiveSetting('catalogIndexUrl').value).toBeNull()
  })

  it('the operator file pins a key', () => {
    writeOperator({ disableSelfUpdate: true, catalogIndexUrl: 'https://mirror.example.com/i.json' })
    expect(effectiveSetting('disableSelfUpdate')).toMatchObject({
      value: true,
      source: 'file',
      pinned: true,
    })
    expect(effectiveSetting('catalogIndexUrl')).toMatchObject({
      value: 'https://mirror.example.com/i.json',
      source: 'file',
      pinned: true,
    })
  })

  it("the key's environment variable wins over the file", () => {
    writeOperator({ disableBrowserAutostart: true })
    vi.stubEnv('CLAWBOO_DISABLE_BROWSER_AUTOSTART', '0')
    expect(effectiveSetting('disableBrowserAutostart')).toMatchObject({
      value: false,
      source: 'environment',
      pinned: true,
    })
  })

  it("a person's own setting applies only where nothing is pinned", () => {
    saveUserSetting('disableBrowserAutostart', true)
    expect(effectiveSetting('disableBrowserAutostart')).toMatchObject({
      value: true,
      source: 'user',
      pinned: false,
    })

    writeOperator({ disableBrowserAutostart: false })
    resetOperatorSettings()
    expect(effectiveSetting('disableBrowserAutostart')).toMatchObject({
      value: false,
      source: 'file',
      pinned: true,
    })
  })

  it('CLAWBOO_OPERATOR_SETTINGS names a file somewhere else', () => {
    const elsewhere = path.join(home, 'etc-operator.json')
    writeFileSync(elsewhere, JSON.stringify({ disableSelfUpdate: true }))
    vi.stubEnv('CLAWBOO_OPERATOR_SETTINGS', elsewhere)
    expect(initOperatorSettings().file).toBe(elsewhere)
    expect(effectiveSetting('disableSelfUpdate').value).toBe(true)
  })

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
  ])('reads %s in a flag variable as %s', (raw, value) => {
    vi.stubEnv('CLAWBOO_DISABLE_SELF_UPDATE', raw)
    expect(effectiveSetting('disableSelfUpdate')).toMatchObject({ value, pinned: true })
  })

  it('an empty variable pins nothing', () => {
    vi.stubEnv('CLAWBOO_DISABLE_SELF_UPDATE', '')
    vi.stubEnv('CLAWBOO_CATALOG_INDEX_URL', '  ')
    expect(effectiveSetting('disableSelfUpdate').pinned).toBe(false)
    expect(effectiveSetting('catalogIndexUrl').pinned).toBe(false)
  })
})

describe('refusing to start', () => {
  const refusal = (): string => {
    try {
      initOperatorSettings()
    } catch (err) {
      expect(err).toBeInstanceOf(OperatorSettingsError)
      return (err as Error).message
    }
    throw new Error('expected a refusal')
  }

  it('on a file that is not JSON', () => {
    writeOperator('{ "disableSelfUpdate": true, }')
    expect(refusal()).toMatch(/is not valid JSON/)
  })

  it('on a file that is not JSON, without quoting the text around the error', () => {
    // The parser's own message quotes the source near the error, and startup
    // logs the refusal.
    writeOperator('{\n  "disableSelfUpdate": true,\n  "mirror": ghp_DoNotEchoThis123\n}')
    const message = refusal()
    expect(message).toMatch(/is not valid JSON/)
    // The parser's quote can stop partway through the value, so any of it counts.
    expect(message).not.toContain('ghp_')
    expect(message).not.toContain('"mirror"')
  })

  it.each([['[]'], ['"text"'], ['null']])('on a file that is not an object (%s)', (doc) => {
    writeOperator(doc)
    expect(refusal()).toMatch(/must hold a JSON object/)
  })

  it('on an unknown key, naming the ones it knows', () => {
    writeOperator({ disableSelfUpdates: true })
    expect(refusal()).toMatch(
      /unknown key "disableSelfUpdates".*disableSelfUpdate, disableBrowserAutostart, catalogIndexUrl/,
    )
  })

  it.each([['apiKey'], ['githubToken'], ['adminPassword'], ['clientSecret'], ['authHeader']])(
    'on a key that looks like a credential (%s), without echoing its value',
    (key) => {
      writeOperator({ [key]: 'sk-do-not-echo' })
      const message = refusal()
      expect(message).toMatch(/must not hold secrets/)
      expect(message).not.toContain('sk-do-not-echo')
    },
  )

  it.each([
    ['https://user:hunter2@mirror.example.com/i.json', 'user name and password'],
    ['https://mirror.example.com/i.json?token=hunter2', 'query string'],
    ['https://mirror.example.com/i.json?api_key=hunter2', 'query string'],
    ['https://mirror.example.com/i.json?access_key=hunter2', 'query string'],
    ['https://mirror.example.com/i.json?X-Amz-Signature=hunter2', 'query string'],
  ])('on a URL that carries a credential (%s)', (url, named) => {
    writeOperator({ catalogIndexUrl: url })
    const message = refusal()
    expect(message).toContain(named)
    expect(message).not.toContain('hunter2')
  })

  it('on a URL whose query names a credential, without repeating the name', () => {
    // A bare `?<token>` makes the token itself the parameter name.
    writeOperator({ catalogIndexUrl: 'https://mirror.example.com/i.json?hunter2_token' })
    const message = refusal()
    expect(message).toMatch(/must not carry credentials/)
    expect(message).not.toContain('hunter2')
  })

  it.each([['monkey'], ['keyboard'], ['v']])(
    'accepts a URL whose query parameter only looks like one (%s)',
    (name) => {
      writeOperator({ catalogIndexUrl: `https://mirror.example.com/i.json?${name}=1` })
      expect(() => initOperatorSettings()).not.toThrow()
    },
  )

  it.each([
    [{ disableSelfUpdate: 'yes' }, /"disableSelfUpdate".*must be true or false/],
    [{ disableSelfUpdate: 1 }, /must be true or false/],
    [{ catalogIndexUrl: 'ftp://mirror.example.com/i.json' }, /http or https URL/],
    [{ catalogIndexUrl: 'not a url' }, /is not a valid URL/],
    [{ catalogIndexUrl: '' }, /http or https URL/],
  ])('on a value of the wrong kind (%j)', (doc, pattern) => {
    writeOperator(doc)
    expect(refusal()).toMatch(pattern)
  })

  it('on a CLAWBOO_OPERATOR_SETTINGS that names a missing file', () => {
    vi.stubEnv('CLAWBOO_OPERATOR_SETTINGS', path.join(home, 'nope.json'))
    expect(refusal()).toMatch(/CLAWBOO_OPERATOR_SETTINGS names .*nope\.json, which does not exist/)
  })

  it('on a folder where the file should be', () => {
    vi.stubEnv('CLAWBOO_OPERATOR_SETTINGS', home)
    expect(refusal()).toMatch(/is not a file/)
  })

  it.skipIf(process.platform === 'win32')('on a file any user can change', () => {
    writeOperator({ disableSelfUpdate: true })
    chmodSync(operatorFile(), 0o666)
    expect(refusal()).toMatch(/can be changed by any user on this machine/)
  })

  it.each([
    ['CLAWBOO_DISABLE_SELF_UPDATE', 'yes', /CLAWBOO_DISABLE_SELF_UPDATE must be 1 or 0/],
    ['CLAWBOO_DISABLE_BROWSER_AUTOSTART', '2', /CLAWBOO_DISABLE_BROWSER_AUTOSTART must be 1 or 0/],
    [
      'CLAWBOO_CATALOG_INDEX_URL',
      'file:///etc/passwd',
      /CLAWBOO_CATALOG_INDEX_URL must be an http/,
    ],
  ])('on %s=%s', (name, raw, pattern) => {
    vi.stubEnv(name, raw)
    expect(refusal()).toMatch(pattern)
  })
})

describe("a person's own setting", () => {
  it('is refused for a key only an administrator sets', () => {
    expect(() => saveUserSetting('disableSelfUpdate', true)).toThrow(PinnedSettingError)
  })

  it('is refused while the key is pinned, and nothing is saved', () => {
    vi.stubEnv('CLAWBOO_DISABLE_BROWSER_AUTOSTART', '1')
    expect(() => saveUserSetting('disableBrowserAutostart', false)).toThrow(/administrator/)
    vi.unstubAllEnvs()
    vi.stubEnv('CLAWBOO_HOME', home)
    expect(effectiveSetting('disableBrowserAutostart').source).toBe('default')
  })

  it('never writes the operator file', () => {
    writeOperator({ catalogIndexUrl: 'https://mirror.example.com/i.json' })
    chmodSync(operatorFile(), 0o644)
    const before = {
      body: readFileSync(operatorFile(), 'utf8'),
      mtime: statSync(operatorFile()).mtimeMs,
    }

    initOperatorSettings()
    saveUserSetting('disableBrowserAutostart', true)
    listEffectiveSettings()

    expect(readFileSync(operatorFile(), 'utf8')).toBe(before.body)
    expect(statSync(operatorFile()).mtimeMs).toBe(before.mtime)
  })
})

describe("agents' screens: a path and a count", () => {
  const refusal = (): string => {
    try {
      initOperatorSettings()
    } catch (err) {
      expect(err).toBeInstanceOf(OperatorSettingsError)
      return (err as Error).message
    }
    throw new Error('expected a refusal')
  }

  it('pins the screen settings from the file and the environment', () => {
    writeOperator({
      computerLinks: 'view',
      xvncPath: '/usr/bin/Xtigervnc',
      disableDesktopToolsInstall: true,
      maxAgentDisplays: 3,
    })
    vi.stubEnv('CLAWBOO_CUA_DRIVER_PATH', '/opt/cua/cua-driver')
    expect(effectiveSetting('computerLinks')).toMatchObject({ value: 'view', source: 'file' })
    expect(effectiveSetting('xvncPath').value).toBe('/usr/bin/Xtigervnc')
    expect(effectiveSetting('cuaDriverPath')).toMatchObject({
      value: '/opt/cua/cua-driver',
      source: 'environment',
    })
    expect(effectiveSetting('disableDesktopToolsInstall').value).toBe(true)
    expect(effectiveSetting('maxAgentDisplays').value).toBe(3)
  })

  it('defaults to links on, nothing named, downloads allowed, and no display cap of its own', () => {
    expect(effectiveSetting('computerLinks').value).toBe('on')
    expect(effectiveSetting('xvncPath').value).toBeNull()
    expect(effectiveSetting('cuaDriverPath').value).toBeNull()
    expect(effectiveSetting('disableDesktopToolsInstall').value).toBe(false)
    expect(effectiveSetting('maxAgentDisplays').value).toBeNull()
  })

  it.each([
    ['relative/Xvnc'],
    ['/usr/bin/../bin/Xvnc'],
    ['/usr//bin/Xvnc'],
    ['/usr/bin/./Xvnc'],
    ['/usr/bin/'],
    ['/usr/bin/X\tvnc'],
  ])('refuses to start on a path not written plainly (%j)', (value) => {
    writeOperator({ xvncPath: value })
    expect(refusal()).toMatch(/must be an absolute path with no "\." or "\.\." part/)
  })

  it('refuses a path from the environment the same way, and a path that is not a string', () => {
    vi.stubEnv('CLAWBOO_CUA_DRIVER_PATH', 'cua-driver')
    expect(refusal()).toMatch(/CLAWBOO_CUA_DRIVER_PATH must be an absolute path/)
    vi.stubEnv('CLAWBOO_CUA_DRIVER_PATH', '')
    writeOperator({ cuaDriverPath: 7 })
    expect(refusal()).toMatch(/must be an absolute path/)
  })

  it('refuses a count out of range or not whole, in the file and the environment', () => {
    for (const value of [0, 65, 2.5, '3']) {
      writeOperator({ maxAgentDisplays: value })
      expect(refusal()).toMatch(/maxAgentDisplays/)
    }
    writeOperator({})
    vi.stubEnv('CLAWBOO_MAX_AGENT_DISPLAYS', 'four')
    expect(refusal()).toMatch(/CLAWBOO_MAX_AGENT_DISPLAYS must be a whole number/)
    vi.stubEnv('CLAWBOO_MAX_AGENT_DISPLAYS', '99')
    expect(refusal()).toMatch(/from 1 to 64/)
  })

  it('refuses a links value it does not know', () => {
    writeOperator({ computerLinks: 'control' })
    expect(refusal()).toMatch(/must be one of: on, view, off/)
  })

  it('offers none of them in the dashboard: only an administrator sets them', () => {
    for (const key of [
      'computerLinks',
      'xvncPath',
      'cuaDriverPath',
      'disableDesktopToolsInstall',
      'maxAgentDisplays',
    ] as const) {
      expect(() => saveUserSetting(key, null as never)).toThrow(PinnedSettingError)
    }
  })
})
