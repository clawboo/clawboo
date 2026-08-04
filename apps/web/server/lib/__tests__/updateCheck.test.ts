import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildUpdateCommand,
  computeSelfVersion,
  detectInstallMethod,
  fetchLatestClawbooVersion,
  invalidateLatestCache,
  semverGt,
} from '../updateCheck'

afterEach(() => {
  vi.unstubAllGlobals()
  invalidateLatestCache()
  delete process.env['CLAWBOO_VERSION']
})

describe('semverGt', () => {
  it('compares major.minor.patch', () => {
    expect(semverGt('0.4.0', '0.3.0')).toBe(true)
    expect(semverGt('1.0.0', '0.9.9')).toBe(true)
    expect(semverGt('0.3.1', '0.3.0')).toBe(true)
    expect(semverGt('0.3.0', '0.3.0')).toBe(false)
    expect(semverGt('0.3.0', '0.4.0')).toBe(false)
  })

  it('treats a release as greater than a prerelease of the same core', () => {
    expect(semverGt('0.3.0', '0.3.0-beta.1')).toBe(true)
    expect(semverGt('0.3.0-beta.1', '0.3.0')).toBe(false)
  })

  it('tolerates a leading v and returns false on unparseable input', () => {
    expect(semverGt('v0.4.0', '0.3.0')).toBe(true)
    expect(semverGt('nonsense', '0.3.0')).toBe(false)
    expect(semverGt('0.4.0', 'nonsense')).toBe(false)
  })
})

describe('buildUpdateCommand', () => {
  it('uses npx for an npx install, npm -g otherwise', () => {
    expect(buildUpdateCommand('npx')).toBe('npx clawboo@latest')
    expect(buildUpdateCommand('global')).toBe('npm install -g clawboo@latest')
    expect(buildUpdateCommand('dev')).toBe('npm install -g clawboo@latest')
  })
})

describe('detectInstallMethod', () => {
  const orig = process.argv[1]
  afterEach(() => {
    process.argv[1] = orig
  })

  it('global for a bundled dist/server.js entry', () => {
    process.argv[1] = '/usr/local/lib/node_modules/clawboo/dist/server.js'
    expect(detectInstallMethod()).toBe('global')
  })

  it('npx for an _npx cache entry', () => {
    process.argv[1] = '/home/u/.npm/_npx/abc123/node_modules/clawboo/dist/server.js'
    expect(detectInstallMethod()).toBe('npx')
  })

  it('dev for a tsx source entry', () => {
    process.argv[1] = '/repo/apps/web/server/index.ts'
    expect(detectInstallMethod()).toBe('dev')
  })
})

describe('fetchLatestClawbooVersion', () => {
  it('returns null and never throws when the registry is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    await expect(fetchLatestClawbooVersion()).resolves.toBeNull()
  })

  it('caches a successful read (one network call for two lookups)', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.9.0' }) }))
    vi.stubGlobal('fetch', f)
    expect(await fetchLatestClawbooVersion()).toBe('0.9.0')
    expect(await fetchLatestClawbooVersion()).toBe('0.9.0')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('serves the cached value when a later probe fails', async () => {
    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.9.0' }) }))
    vi.stubGlobal('fetch', ok)
    // Prime the cache, then force a re-fetch by expiring it and failing the call.
    expect(await fetchLatestClawbooVersion(0)).toBe('0.9.0')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('registry down')
      }),
    )
    // A far-future "now" expires the 6h TTL → re-fetch → fails → last cache wins.
    expect(await fetchLatestClawbooVersion(1e13)).toBe('0.9.0')
  })
})

describe('computeSelfVersion', () => {
  it('flags updateAvailable when latest > current', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) })),
    )
    process.env['CLAWBOO_VERSION'] = '0.3.0'
    const info = await computeSelfVersion()
    expect(info.current).toBe('0.3.0')
    expect(info.latest).toBe('9.9.9')
    expect(info.updateAvailable).toBe(true)
    expect(info.updateCommand).toContain('clawboo@latest')
  })

  it('flags a PATCH release as an update (0.3.0 → 0.3.1)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.3.1' }) })),
    )
    process.env['CLAWBOO_VERSION'] = '0.3.0'
    const info = await computeSelfVersion()
    expect(info.latest).toBe('0.3.1')
    expect(info.updateAvailable).toBe(true)
  })

  it('never nags a dev version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) })),
    )
    process.env['CLAWBOO_VERSION'] = '0.0.0-dev'
    const info = await computeSelfVersion()
    expect(info.updateAvailable).toBe(false)
  })

  it('offline: latest null, updateAvailable false (silent no-op)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    process.env['CLAWBOO_VERSION'] = '0.3.0'
    const info = await computeSelfVersion()
    expect(info.latest).toBeNull()
    expect(info.updateAvailable).toBe(false)
  })

  it('marks a 0.1.x current as deprecated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.3.0' }) })),
    )
    process.env['CLAWBOO_VERSION'] = '0.1.5'
    const info = await computeSelfVersion()
    expect(info.isDeprecated).toBe(true)
    expect(info.updateAvailable).toBe(true)
  })

  // The `clawboo` launcher hits this on every attach (via `?local=1`) to compare
  // the running server against its own version. It must never reach the network:
  // a registry probe is capped at 5s and never caches a failure, so an offline
  // machine would pay that on every launch.
  it('skipRegistry: reports `current` without touching the registry', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }))
    vi.stubGlobal('fetch', fetchSpy)
    process.env['CLAWBOO_VERSION'] = '0.3.0'
    const info = await computeSelfVersion({ skipRegistry: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(info.current).toBe('0.3.0')
    expect(info.installMethod).toBeDefined()
    // "not checked" reads exactly like the offline case.
    expect(info.latest).toBeNull()
    expect(info.updateAvailable).toBe(false)
    expect(info.checkedAt).toBeNull()
  })

  it('skipRegistry: reports null checkedAt even with a warm cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) })),
    )
    process.env['CLAWBOO_VERSION'] = '0.3.0'
    // Warm the module-level cache.
    expect(await fetchLatestClawbooVersion()).toBe('9.9.9')
    const info = await computeSelfVersion({ skipRegistry: true })
    expect(info.latest).toBeNull()
    // `checkedAt` describes when `latest` was fetched; we aren't returning one.
    expect(info.checkedAt).toBeNull()
  })
})
