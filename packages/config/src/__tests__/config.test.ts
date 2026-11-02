import fs from 'node:fs'
import path from 'node:path'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isGatewayConfigured,
  resolveStateDir,
  loadSettings,
  resolveSettingsPath,
  resolveClawbooDir,
} from '../index'

// Mock node:fs module
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

describe('resolveStateDir', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses OPENCLAW_STATE_DIR env var when set', () => {
    const result = resolveStateDir({ OPENCLAW_STATE_DIR: '/custom/state' })
    expect(result).toContain('custom')
    expect(result).toContain('state')
  })

  it('uses MOLTBOT_STATE_DIR as fallback', () => {
    const result = resolveStateDir({ MOLTBOT_STATE_DIR: '/moltbot/state' })
    expect(result).toContain('moltbot')
  })

  it('returns default .openclaw dir when no env vars set', () => {
    const result = resolveStateDir({})
    expect(result).toContain('.openclaw')
  })

  it('prefers OPENCLAW_STATE_DIR over MOLTBOT_STATE_DIR', () => {
    const result = resolveStateDir({
      OPENCLAW_STATE_DIR: '/primary',
      MOLTBOT_STATE_DIR: '/fallback',
    })
    expect(result).toContain('primary')
  })
})

describe('resolveSettingsPath', () => {
  it('returns path ending with clawboo/settings.json', () => {
    const result = resolveSettingsPath({})
    expect(result).toContain('clawboo')
    expect(result).toContain('settings.json')
  })
})

describe('resolveClawbooDir (the CLI now uses this exact resolver)', () => {
  it('path.resolve()s a RELATIVE CLAWBOO_HOME to an absolute path (not verbatim)', () => {
    const result = resolveClawbooDir({ CLAWBOO_HOME: 'relative/clawboo-home' })
    // The CLI's old inline mirror returned a relative override verbatim — the
    // divergence this aligns. The real resolver always yields an absolute path.
    expect(path.isAbsolute(result)).toBe(true)
    expect(result).toBe(path.resolve('relative/clawboo-home'))
  })

  it('defaults to a <home>/.clawboo absolute path when CLAWBOO_HOME is unset', () => {
    const result = resolveClawbooDir({})
    expect(path.isAbsolute(result)).toBe(true)
    expect(result.endsWith(path.join('', '.clawboo')) || result.includes('.clawboo')).toBe(true)
  })

  it('expands a ~ override to an absolute path', () => {
    const result = resolveClawbooDir({ CLAWBOO_HOME: '~/sub' })
    expect(path.isAbsolute(result)).toBe(true)
    expect(result.endsWith('sub')).toBe(true)
  })
})

describe('loadSettings', () => {
  it('returns defaults when no settings file exists', () => {
    const settings = loadSettings({})
    expect(settings).toHaveProperty('gatewayUrl')
    expect(settings).toHaveProperty('gatewayToken')
    expect(settings.gatewayUrl).toBe('ws://localhost:18789')
    expect(settings.gatewayToken).toBe('')
  })

  it('does not throw when settings file is missing', () => {
    expect(() => loadSettings({})).not.toThrow()
  })

  it('returns ClawbooSettings shape', () => {
    const settings = loadSettings({})
    expect(typeof settings.gatewayUrl).toBe('string')
    expect(typeof settings.gatewayToken).toBe('string')
  })
})

describe('isGatewayConfigured', () => {
  const env = { CLAWBOO_HOME: '/h/.clawboo', OPENCLAW_STATE_DIR: '/h/.openclaw' }
  const settingsFile = path.resolve('/h/.clawboo/settings.json')
  const openclawConfig = path.resolve('/h/.openclaw/openclaw.json')

  afterEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(() => false)
    vi.mocked(fs.readFileSync).mockImplementation(() => '{}')
  })

  it('is false on an install that never set OpenClaw up', () => {
    expect(isGatewayConfigured(env)).toBe(false)
    // loadSettings still answers with the default address, which is why the
    // health check cannot use it to tell "never set up" from "down".
    expect(loadSettings(env).gatewayUrl).toBe('ws://localhost:18789')
  })

  it('is true when clawboo settings name a Gateway', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === settingsFile)
    vi.mocked(fs.readFileSync).mockImplementation(() =>
      JSON.stringify({ gateway: { url: 'ws://10.0.0.5:18789' } }),
    )
    expect(isGatewayConfigured(env)).toBe(true)
  })

  it('is false when clawboo settings carry only blank Gateway fields', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === settingsFile)
    vi.mocked(fs.readFileSync).mockImplementation(() =>
      JSON.stringify({ gateway: { url: '  ', token: '' }, firstRunDismissedAt: 1 }),
    )
    expect(isGatewayConfigured(env)).toBe(false)
  })

  it("is true when OpenClaw's own config file exists", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === openclawConfig)
    expect(isGatewayConfigured(env)).toBe(true)
  })
})
