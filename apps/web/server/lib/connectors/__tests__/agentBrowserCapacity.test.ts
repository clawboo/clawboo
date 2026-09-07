// The cap actually caps.
//
// The sibling suite deliberately avoids the spawn path because a real spawn
// downloads and launches a headed Chromium. This one reaches it with the
// handshake faked, because the property under test lives entirely in the gap the
// handshake creates: capacity was read from the browsers map, but a browser is
// not IN that map until the handshake returns, and that is seconds of `npx` plus
// a cold profile launch. Every caller inside the gap read the same stale count,
// so a board fan-out put all of them past a cap of four and launched a real
// Chromium for each. The cap's own check was the thing that let it happen.
//
// Faking the handshake is what makes the window controllable: these tests hold
// every spawn open until the assertion has been made.

import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MAX = 4

let inFlight = 0
let peakInFlight = 0
/** Resolvers for the spawns currently parked inside the fake handshake. */
let parked: (() => void)[] = []
let failNext = false

vi.mock('@clawboo/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/mcp')>()
  return {
    ...actual,
    connectStdioConnector: async () => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise<void>((resolve) => parked.push(resolve))
      inFlight -= 1
      if (failNext) throw new Error('handshake refused')
      return {
        // NO PID ON PURPOSE. `closeAgentBrowser` calls `killProcessTreeByPid` for
        // any numeric pid, so inventing one here would have this suite kill an
        // unrelated process on whatever machine runs it.
        pid: undefined,
        close: async () => {},
        onClose: () => {},
        callTool: async () => ({ content: [] }),
        listTools: async () => [],
      }
    },
  }
})

const spec = {
  slug: 'playwright',
  command: 'node',
  args: ['-e', ''],
  profileFlag: '--user-data-dir',
}

let prevHome: string | undefined
let mod: typeof import('../agentBrowsers')

beforeEach(async () => {
  prevHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = path.join('/tmp', `clawboo-cap-${Date.now()}-${peakInFlight}`)
  inFlight = 0
  peakInFlight = 0
  parked = []
  failNext = false
  vi.resetModules()
  mod = await import('../agentBrowsers')
})

afterEach(async () => {
  parked.splice(0).forEach((r) => r())
  await mod.closeAllAgentBrowsers()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
})

/** Let parked spawns and their continuations settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('agent browser capacity', () => {
  it('never spawns more than the cap, even when every agent asks at once', async () => {
    // The board fan-out. Six agents, none with a browser, all calling in the same
    // tick. Before the reservation counter every one of them read totalOpen() === 0
    // and proceeded, so six real Chromiums launched against a cap of four.
    const calls = Array.from({ length: MAX + 2 }, (_, i) =>
      mod
        .agentBrowserSession(spec, 'conn:browser', `agent-${i}`, { create: true })
        .catch(() => null),
    )
    await settle()

    // THE ASSERTION: at most four may be inside a handshake at once.
    expect(peakInFlight).toBe(MAX)

    // Let those four finish and be recorded. The other two are queued, correctly:
    // four browsers are open against a cap of four.
    parked.splice(0).forEach((r) => r())
    await settle()
    expect(mod.openAgentBrowserCount()).toBe(MAX)

    // Closing two hands a slot to each waiter, one apiece rather than waking both
    // on one slot — which is what `drainWaiting` claiming as it wakes buys.
    await mod.closeAgentBrowser('conn:browser', 'agent-0')
    await mod.closeAgentBrowser('conn:browser', 'agent-1')
    await settle()
    parked.splice(0).forEach((r) => r())
    await Promise.all(calls)

    // The cap held across the whole run, not merely the first wave.
    expect(peakInFlight).toBe(MAX)
    expect(mod.openAgentBrowserCount()).toBeLessThanOrEqual(MAX)
  })

  it('does not leak a slot when a spawn FAILS', async () => {
    // The way this fix breaks if the release is not in a `finally`: the counter
    // only climbs, and once it reaches the cap every later call queues and then
    // fails with "every browser is busy" while zero browsers are open. Nothing
    // short of a restart recovers that, which is worse than the race.
    failNext = true
    const doomed = Array.from({ length: MAX }, (_, i) =>
      mod
        .agentBrowserSession(spec, 'conn:browser', `doomed-${i}`, { create: true })
        .catch(() => null),
    )
    await settle()
    parked.splice(0).forEach((r) => r())
    await Promise.all(doomed)
    expect(mod.openAgentBrowserCount()).toBe(0)

    // Every slot should be free again, so a fresh spawn must reach the handshake
    // rather than queueing behind reservations nobody holds.
    failNext = false
    peakInFlight = 0
    const after = mod
      .agentBrowserSession(spec, 'conn:browser', 'after', { create: true })
      .catch(() => null)
    await settle()
    expect(peakInFlight).toBe(1)
    parked.splice(0).forEach((r) => r())
    await after
  })
})
