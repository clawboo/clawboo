import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveStateDir, loadSettings, resolveSettingsPath } from '../index'

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
