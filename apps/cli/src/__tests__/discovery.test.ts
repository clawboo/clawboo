// `probeDashboard` decides what is listening on a port, and `discoverDashboard`
// turns that into "attach here" / "it's gated" / "nothing running". Getting the
// gated case wrong is what made a token-gated install fork a fresh orphaned
// server on every `clawboo` run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { discoverDashboard, probeDashboard } from '../lifecycle'

const PORT = 18790

/** Minimal stand-in for the `fetch` Response shape `probeDashboard` reads. */
function response(status: number, contentType: string, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  }
}

const CLAWBOO_SETTINGS = { gatewayUrl: 'http://localhost:18789', hasToken: false }
// The exact body `packages/gateway-proxy/src/access-gate.ts` writes on a 401.
const GATE_401 = {
  error: 'Clawboo access token required. Open /?access_token=<token> once to set a cookie.',
}

let originalEnv: string | undefined

beforeEach(() => {
  originalEnv = process.env['CLAWBOO_API_PORT']
  // Pin discovery to a single port so these tests never scan 20 ports or read
  // the developer's real ~/.clawboo/api-port.txt.
  process.env['CLAWBOO_API_PORT'] = String(PORT)
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env['CLAWBOO_API_PORT']
  else process.env['CLAWBOO_API_PORT'] = originalEnv
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('probeDashboard', () => {
  it('reports none when nothing is listening', async () => {
    // Nothing is bound on this port in the test process, so the TCP probe fails.
    expect(await probeDashboard('localhost', 1, 50)).toBe('none')
  })
})

describe('probeDashboard over a stubbed HTTP layer', () => {
  // `probePort` is a real TCP connect, so bind a throwaway listener and probe it.
  let server: import('net').Server
  let livePort: number

  beforeEach(async () => {
    const net = await import('net')
    server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    livePort = (server.address() as import('net').AddressInfo).port
    process.env['CLAWBOO_API_PORT'] = String(livePort)
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('reports clawboo for a Clawboo-shaped /api/settings', async () => {
    vi.stubGlobal('fetch', async () => response(200, 'application/json', CLAWBOO_SETTINGS))
    expect(await probeDashboard('127.0.0.1', livePort, 500)).toBe('clawboo')
  })

  it('reports gated for the access gate 401', async () => {
    vi.stubGlobal('fetch', async () => response(401, 'application/json', GATE_401))
    expect(await probeDashboard('127.0.0.1', livePort, 500)).toBe('gated')
  })

  it('does not read an unrelated JSON 401 as Clawboo', async () => {
    vi.stubGlobal('fetch', async () => response(401, 'application/json', { error: 'Unauthorized' }))
    expect(await probeDashboard('127.0.0.1', livePort, 500)).toBe('none')
  })

  it('rejects a 200 that is not Clawboo-shaped', async () => {
    vi.stubGlobal('fetch', async () => response(200, 'application/json', [{ id: 'devtools' }]))
    expect(await probeDashboard('127.0.0.1', livePort, 500)).toBe('none')
  })

  it('rejects a non-JSON response (the SPA catch-all on an old server)', async () => {
    vi.stubGlobal('fetch', async () => response(200, 'text/html', null))
    expect(await probeDashboard('127.0.0.1', livePort, 500)).toBe('none')
  })

  it('reports none when the request throws', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNRESET')
    })
    expect(await probeDashboard('127.0.0.1', livePort, 500)).toBe('none')
  })

  describe('discoverDashboard', () => {
    it('returns the port when the dashboard is usable', async () => {
      vi.stubGlobal('fetch', async () => response(200, 'application/json', CLAWBOO_SETTINGS))
      expect(await discoverDashboard()).toEqual({ port: livePort, gatedPort: null })
    })

    // The regression: this used to read as "nothing is running", so the launcher
    // forked a second server onto the same database.
    it('separates a gated instance from "nothing running"', async () => {
      vi.stubGlobal('fetch', async () => response(401, 'application/json', GATE_401))
      expect(await discoverDashboard()).toEqual({ port: null, gatedPort: livePort })
    })

    it('reports nothing at all when the port is not Clawboo', async () => {
      vi.stubGlobal('fetch', async () => response(401, 'text/plain', null))
      expect(await discoverDashboard()).toEqual({ port: null, gatedPort: null })
    })
  })
})
