// Owner-only writes for credential files, against the real filesystem (config.test.ts
// mocks node:fs, so these live apart). The mode assertions are POSIX-only: Windows
// has no group/other bits for chmod to clear.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadSettings, mkdirPrivateSync, saveSettings, writePrivateFileSync } from '../index'

const posixOnly = it.skipIf(process.platform === 'win32')
const modeOf = (p: string): number => statSync(p).mode & 0o777

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'clawboo-private-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

/** Make every chmod fail, as it does on a file another user owns. */
function failChmod(): void {
  vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  })
}

describe('writePrivateFileSync', () => {
  it('writes the contents', () => {
    const file = path.join(tmp, '.env')
    writePrivateFileSync(file, 'KEY=one\n')
    writePrivateFileSync(file, 'KEY=two\n')
    expect(readFileSync(file, 'utf8')).toBe('KEY=two\n')
  })

  posixOnly('creates a new file 0600', () => {
    const file = path.join(tmp, '.env')
    writePrivateFileSync(file, 'KEY=secret\n')
    expect(modeOf(file)).toBe(0o600)
  })

  posixOnly('narrows an existing world-readable file to 0600', () => {
    const file = path.join(tmp, '.env')
    writeFileSync(file, 'OLD=1\n')
    chmodSync(file, 0o644)
    writePrivateFileSync(file, 'KEY=secret\n')
    expect(modeOf(file)).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe('KEY=secret\n')
  })

  posixOnly('refuses to write a file others can read when its mode cannot be narrowed', () => {
    const file = path.join(tmp, '.env')
    writeFileSync(file, 'OLD=1\n')
    chmodSync(file, 0o644)
    failChmod()
    expect(() => writePrivateFileSync(file, 'KEY=secret\n')).toThrow(/refusing to write/)
    expect(readFileSync(file, 'utf8')).toBe('OLD=1\n')
  })

  posixOnly('still writes when the chmod fails on a file that is already owner-only', () => {
    const file = path.join(tmp, '.env')
    writeFileSync(file, 'OLD=1\n')
    chmodSync(file, 0o600)
    failChmod()
    writePrivateFileSync(file, 'KEY=secret\n')
    expect(readFileSync(file, 'utf8')).toBe('KEY=secret\n')
  })
})

describe('mkdirPrivateSync', () => {
  posixOnly('creates every missing directory 0700', () => {
    const dir = path.join(tmp, 'a', 'b')
    mkdirPrivateSync(dir)
    expect(modeOf(path.join(tmp, 'a'))).toBe(0o700)
    expect(modeOf(dir)).toBe(0o700)
  })

  posixOnly('leaves an existing directory as it was', () => {
    const dir = path.join(tmp, 'shared')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    mkdirPrivateSync(dir)
    expect(modeOf(dir)).toBe(0o755)
  })
})

describe('saveSettings', () => {
  const env = (): NodeJS.ProcessEnv => ({ CLAWBOO_HOME: path.join(tmp, '.clawboo') })

  it('round-trips through loadSettings', () => {
    saveSettings({ gatewayUrl: 'ws://localhost:18789', gatewayToken: 'gw-token' }, env())
    const loaded = loadSettings(env())
    expect(loaded.gatewayUrl).toBe('ws://localhost:18789')
    expect(loaded.gatewayToken).toBe('gw-token')
  })

  posixOnly('creates settings.json 0600 inside a new 0700 Clawboo folder', () => {
    saveSettings({ gatewayToken: 'gw-token', studioAccessToken: 'studio-token' }, env())
    expect(modeOf(path.join(tmp, '.clawboo'))).toBe(0o700)
    expect(modeOf(path.join(tmp, '.clawboo', 'settings.json'))).toBe(0o600)
  })

  posixOnly('narrows a settings.json an older version left world-readable', () => {
    const dir = path.join(tmp, '.clawboo')
    mkdirSync(dir)
    const file = path.join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ gateway: { url: 'ws://localhost:18789' } }))
    chmodSync(file, 0o644)
    saveSettings({ gatewayToken: 'gw-token' }, env())
    expect(modeOf(file)).toBe(0o600)
  })
})
