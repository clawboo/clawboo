// The SEARCH SPACE `discoverDashboard` walks, as opposed to the verdict it
// reaches on any one port (that is `discovery.test.ts`). Three behaviours that
// decide where `npx clawboo` sends the browser:
//
//   1. `CLAWBOO_API_PORT` is the WHOLE search space when it parses — an explicit
//      choice gets no fallback, so a dead pin must report nothing rather than
//      quietly attaching to some other port. A value that does NOT parse must be
//      ignored entirely rather than poisoning discovery.
//   2. The runtime `api-port.txt` is tried before the scan, but only as a HINT:
//      a stale file (the server it names has since died) has to fall through to
//      the window instead of stranding the launcher.
//   3. When nothing in 18790-18809 answers, discovery reports nothing — that is
//      the signal the launcher uses to decide to fork a server.
//
// `net` is mocked rather than bound for real. `discovery.test.ts` binds a
// throwaway listener and pins CLAWBOO_API_PORT to it precisely so it never scans;
// these tests are ABOUT the scan, and a real one would probe 18790-18809 on the
// developer's machine — where a running Clawboo would answer and turn the
// all-ports-busy case red for a reason unrelated to the code.

import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.hoisted` (not a plain const) because vitest lifts `vi.mock` above the
// imports: the factory runs while `../lifecycle` is being loaded, which is
// before a normal module-level `const` would be initialised, so the factory
// would hit its temporal dead zone.
const tcp = vi.hoisted(() => ({
  /** Ports the fake TCP layer should accept. Mutated per test. */
  openPorts: new Set<number>(),
  /** Every port `probePort` attempted, in order. */
  probed: [] as number[],
}))

vi.mock('net', () => ({
  createConnection: ({ port }: { port: number }) => {
    tcp.probed.push(port)
    const sock = new EventEmitter() as EventEmitter & { destroy: () => void }
    sock.destroy = () => {}
    // Emit after the caller has attached its listeners.
    setImmediate(() =>
      sock.emit(tcp.openPorts.has(port) ? 'connect' : 'error', new Error('ECONNREFUSED')),
    )
    return sock
  },
}))

import {
  DEFAULT_API_PORT,
  MAX_PORT_ATTEMPTS,
  discoverDashboard,
  getRuntimePortFilePath,
  readRuntimePort,
} from '../lifecycle'

const WINDOW = Array.from({ length: MAX_PORT_ATTEMPTS }, (_, i) => DEFAULT_API_PORT + i)
const CLAWBOO_SETTINGS = { gatewayUrl: 'http://localhost:18789', hasToken: false }

/** Every port that TCP-connects answers as a healthy Clawboo. */
function stubClawbooHttp() {
  vi.stubGlobal('fetch', async () => ({
    status: 200,
    ok: true,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => CLAWBOO_SETTINGS,
  }))
}

let home: string
let previousHome: string | undefined
let previousPort: string | undefined

beforeEach(() => {
  tcp.probed = []
  tcp.openPorts.clear()
  stubClawbooHttp()
  previousHome = process.env['CLAWBOO_HOME']
  previousPort = process.env['CLAWBOO_API_PORT']
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-candidates-'))
  process.env['CLAWBOO_HOME'] = home
  // Both discovery inputs start unset; each test opts in to the one it exercises.
  delete process.env['CLAWBOO_API_PORT']
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = previousHome
  if (previousPort === undefined) delete process.env['CLAWBOO_API_PORT']
  else process.env['CLAWBOO_API_PORT'] = previousPort
  rmSync(home, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/** Seed the runtime port file the server writes on bind. */
function writePortFile(contents: string) {
  writeFileSync(path.join(home, 'api-port.txt'), contents, 'utf8')
}

// ─── 1. CLAWBOO_API_PORT ──────────────────────────────────────────────────────

describe('CLAWBOO_API_PORT — a valid pin is the whole search space', () => {
  it('probes only the pinned port and returns it', async () => {
    process.env['CLAWBOO_API_PORT'] = '18795'
    tcp.openPorts.add(18795)
    tcp.openPorts.add(DEFAULT_API_PORT) // would also answer, but must never be reached
    expect(await discoverDashboard()).toEqual({ port: 18795, gatedPort: null })
    expect(tcp.probed).toEqual([18795])
  })

  it('a DEAD pin reports nothing rather than falling back to the window', async () => {
    // Load-bearing: an explicit port is a user instruction. Falling through would
    // silently open a dashboard they did not ask for.
    process.env['CLAWBOO_API_PORT'] = '18795'
    tcp.openPorts.add(DEFAULT_API_PORT)
    expect(await discoverDashboard()).toEqual({ port: null, gatedPort: null })
    expect(tcp.probed).toEqual([18795])
  })

  it('a dead pin beats even a live api-port.txt — no fallback means no fallback', async () => {
    process.env['CLAWBOO_API_PORT'] = '18795'
    writePortFile('18801')
    tcp.openPorts.add(18801)
    expect(await discoverDashboard()).toEqual({ port: null, gatedPort: null })
    expect(tcp.probed).toEqual([18795])
  })
})

describe('CLAWBOO_API_PORT — an unparseable pin is ignored, not honoured', () => {
  // Each of these must read as "unset" so discovery still finds a real server.
  // '' is what scripts/test-clean-install.mjs passes to blank the pin.
  for (const raw of ['', '   ', 'abc', '0', '-1', '65536', '18790abc', 'NaN', 'Infinity']) {
    it(`falls through to the runtime port file for ${JSON.stringify(raw)}`, async () => {
      process.env['CLAWBOO_API_PORT'] = raw
      writePortFile('18801')
      tcp.openPorts.add(18801)
      expect(await discoverDashboard()).toEqual({ port: 18801, gatedPort: null })
      // The file hint came first; the pin contributed nothing.
      expect(tcp.probed[0]).toBe(18801)
    })
  }

  it('rejects a FRACTIONAL pin instead of handing it to the socket layer', async () => {
    // `Number.isInteger`, not `isFinite`: 18790.5 used to reach createConnection,
    // which throws ERR_SOCKET_BAD_PORT synchronously.
    process.env['CLAWBOO_API_PORT'] = '18790.5'
    writePortFile('18801')
    tcp.openPorts.add(18801)
    expect(await discoverDashboard()).toEqual({ port: 18801, gatedPort: null })
    expect(tcp.probed).not.toContain(18790.5)
  })
})

// ─── 2. The runtime api-port.txt ──────────────────────────────────────────────

describe('readRuntimePort — the file the server writes on bind', () => {
  it('reads the recorded port', () => {
    writePortFile('18795')
    expect(readRuntimePort()).toBe(18795)
  })

  it('tolerates trailing whitespace and CRLF (a Windows-written file)', () => {
    writePortFile('18795\r\n')
    expect(readRuntimePort()).toBe(18795)
  })

  it('returns null when the file is absent (a fresh install)', () => {
    expect(readRuntimePort()).toBeNull()
  })

  it('returns null on garbage, out-of-range, and fractional contents', () => {
    for (const raw of ['not-a-port', '', '0', '-1', '70000', '18790.5']) {
      writePortFile(raw)
      expect(readRuntimePort()).toBeNull()
    }
  })

  it('resolves to <CLAWBOO_HOME>/api-port.txt', () => {
    expect(getRuntimePortFilePath()).toBe(path.join(home, 'api-port.txt'))
  })
})

describe('api-port.txt — live is used, stale falls through to the window', () => {
  it('a LIVE file short-circuits the scan entirely', async () => {
    // The `npx clawboo` twice case: the running server recorded its port here.
    writePortFile('18801')
    tcp.openPorts.add(18801)
    tcp.openPorts.add(DEFAULT_API_PORT)
    expect(await discoverDashboard()).toEqual({ port: 18801, gatedPort: null })
    expect(tcp.probed).toEqual([18801])
  })

  it('a STALE file (its server is gone) falls through and the scan wins', async () => {
    writePortFile('18805')
    tcp.openPorts.add(18792) // a different server is actually up
    expect(await discoverDashboard()).toEqual({ port: 18792, gatedPort: null })
    // Hint first, then the window in ascending order until the hit.
    expect(tcp.probed).toEqual([18805, 18790, 18791, 18792])
  })

  it('an unparseable file contributes no candidate at all', async () => {
    writePortFile('garbage')
    tcp.openPorts.add(DEFAULT_API_PORT)
    expect(await discoverDashboard()).toEqual({ port: DEFAULT_API_PORT, gatedPort: null })
    expect(tcp.probed).toEqual([DEFAULT_API_PORT])
  })
})

// ─── 3. The scan and the all-ports-busy fallback ─────────────────────────────

describe('the 18790-18809 window', () => {
  it('scans ascending and stops at the first Clawboo', async () => {
    tcp.openPorts.add(18793)
    tcp.openPorts.add(18797)
    expect(await discoverDashboard()).toEqual({ port: 18793, gatedPort: null })
    expect(tcp.probed).toEqual([18790, 18791, 18792, 18793])
  })

  it('reports nothing when every port in the window is CLOSED', async () => {
    // The all-ports-busy fallback: a null port is what tells the launcher to
    // fork its own server rather than attach to something.
    expect(await discoverDashboard()).toEqual({ port: null, gatedPort: null })
    expect(tcp.probed).toEqual(WINDOW)
    expect(tcp.probed).toHaveLength(20)
    expect(tcp.probed.at(-1)).toBe(18809)
  })

  it('reports nothing when every port is OCCUPIED by something that is not Clawboo', async () => {
    // The harder half of the same fallback, and the one a regression would slip
    // through: every port answers TCP, so a probe that stopped at "something is
    // listening" would return 18790 here. Only the JSON signature check makes
    // this null.
    for (const port of WINDOW) tcp.openPorts.add(port)
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ some: 'other service' }),
    }))
    expect(await discoverDashboard()).toEqual({ port: null, gatedPort: null })
    expect(tcp.probed).toEqual(WINDOW)
  })

  it('pins the window every doc and comment quotes', () => {
    expect(DEFAULT_API_PORT).toBe(18790)
    expect(MAX_PORT_ATTEMPTS).toBe(20)
    expect(DEFAULT_API_PORT + MAX_PORT_ATTEMPTS - 1).toBe(18809)
  })

  it('a TCP-open port that is not Clawboo does not stop the scan', async () => {
    // The 18791 Gateway-aux case the clean-install gate guards end to end.
    tcp.openPorts.add(18791)
    tcp.openPorts.add(18794)
    vi.stubGlobal('fetch', async (url: string) => {
      const isGatewayAux = url.includes(':18791')
      return {
        status: isGatewayAux ? 401 : 200,
        ok: !isGatewayAux,
        headers: { get: () => 'application/json' },
        json: async () => (isGatewayAux ? { error: 'Unauthorized' } : CLAWBOO_SETTINGS),
      }
    })
    expect(await discoverDashboard()).toEqual({ port: 18794, gatedPort: null })
    expect(tcp.probed).toEqual([18790, 18791, 18792, 18793, 18794])
  })
})
