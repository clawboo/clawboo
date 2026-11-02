// The idle close, across a machine sleep.
//
// The handshake is faked, as in the capacity suite, so no real browser launches:
// what is under test is only when an open browser gets closed.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clawboo/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/mcp')>()
  return {
    ...actual,
    connectStdioConnector: async () => ({
      // NO PID ON PURPOSE: `closeAgentBrowser` kills any numeric pid, and an
      // invented one would be some unrelated process on the machine running this.
      pid: undefined,
      close: async () => {},
      onClose: () => {},
      callTool: async () => ({ content: [] }),
      listTools: async () => [],
    }),
  }
})

const MIN = 60_000
/** The module's default idle limit (`CLAWBOO_AGENT_BROWSER_IDLE_MS` unset). */
const IDLE_MS = 10 * MIN
const CONNECTOR = 'conn:browser'

const spec = {
  slug: 'playwright',
  command: 'node',
  args: ['-e', ''],
  profileFlag: '--user-data-dir',
}

/** What a sleep does to the process on macOS: the wall clock jumps, and every
 *  timer whose delay passed fires once on wake. `vi.setSystemTime` alone moves
 *  pending timers along with the clock, so a plain timer would never notice. */
function sleepMachine(ms: number): void {
  ;(globalThis.setTimeout as unknown as { clock: { jump(ms: number): void } }).clock.jump(ms)
}

let stateDir: string
let prevHome: string | undefined
let mod: typeof import('../agentBrowsers')

beforeEach(async () => {
  prevHome = process.env['CLAWBOO_HOME']
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-idle-'))
  process.env['CLAWBOO_HOME'] = stateDir
  vi.resetModules()
  mod = await import('../agentBrowsers')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await mod.closeAllAgentBrowsers()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  await rm(stateDir, { recursive: true, force: true })
})

describe('the agent browser idle close counts awake time', () => {
  it('a sleep longer than the idle limit does not close the browser on wake', async () => {
    await mod.agentBrowserSession(spec, CONNECTOR, 'a1', { create: true })
    await vi.advanceTimersByTimeAsync(4 * MIN)

    // An hour asleep, then one tick on wake.
    sleepMachine(60 * MIN)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mod.hasAgentBrowser(CONNECTOR, 'a1')).toBe(true)

    // Left untouched after the wake, it is still closed in awake time.
    await vi.advanceTimersByTimeAsync(6 * MIN)
    expect(mod.hasAgentBrowser(CONNECTOR, 'a1')).toBe(false)
  })

  it('a browser that really sits idle is still closed at the limit', async () => {
    await mod.agentBrowserSession(spec, CONNECTOR, 'a1', { create: true })
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(mod.hasAgentBrowser(CONNECTOR, 'a1')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(mod.hasAgentBrowser(CONNECTOR, 'a1')).toBe(false)
  })
})
