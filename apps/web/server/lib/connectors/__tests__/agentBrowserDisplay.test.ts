// An agent's browser opens on that agent's own display, holds the display while
// it runs, and lets go of it when it closes. And while a person has taken over
// the screen, the browser is in use: it is neither idled out nor evicted.
//
// The handshake is faked (as in agentBrowserCapacity.test.ts) so no real
// browser starts, and so is the display manager, whose own suite covers it.

import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({
  envs: [] as Record<string, string | undefined>[],
  closers: [] as (() => void)[],
  display: null as { env: Record<string, string> } | null,
  acquired: [] as [string, string][],
  released: [] as [string, string][],
}))

vi.mock('@clawboo/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/mcp')>()
  return {
    ...actual,
    connectStdioConnector: async (opts: { env: Record<string, string | undefined> }) => {
      seen.envs.push(opts.env)
      return {
        // NO PID ON PURPOSE: closeAgentBrowser kills any numeric pid's tree.
        pid: undefined,
        close: async () => {},
        onClose: (fn: () => void) => seen.closers.push(fn),
        callTool: async () => ({ text: '' }),
        listTools: async () => [],
      }
    },
  }
})

const displayListeners = vi.hoisted(() => new Set<(agentId: string, d: unknown) => void>())
vi.mock('../../desktop/displays', () => ({
  onDisplayChange: (fn: (agentId: string, d: unknown) => void) => {
    displayListeners.add(fn)
    return () => displayListeners.delete(fn)
  },
  acquireDisplay: async (agentId: string, holder: string) => {
    seen.acquired.push([agentId, holder])
    return seen.display
  },
  displayFor: () => seen.display,
  releaseDisplay: (agentId: string, holder: string) => {
    seen.released.push([agentId, holder])
  },
}))

const spec = {
  slug: 'playwright',
  command: 'node',
  args: ['-e', ''],
  profileFlag: '--user-data-dir',
}

let prevHome: string | undefined
let prevIdle: string | undefined
let mod: typeof import('../agentBrowsers')
let control: typeof import('../../desktop/control')

beforeEach(async () => {
  prevHome = process.env['CLAWBOO_HOME']
  prevIdle = process.env['CLAWBOO_AGENT_BROWSER_IDLE_MS']
  process.env['CLAWBOO_HOME'] = path.join('/tmp', `clawboo-display-${Date.now()}`)
  process.env['CLAWBOO_AGENT_BROWSER_IDLE_MS'] = '60000'
  seen.envs.length = 0
  seen.closers.length = 0
  seen.acquired.length = 0
  seen.released.length = 0
  displayListeners.clear()
  seen.display = { env: { DISPLAY: ':42', XAUTHORITY: '/agent/desktops/x/Xauthority' } }
  vi.resetModules()
  mod = await import('../agentBrowsers')
  control = await import('../../desktop/control')
})

afterEach(async () => {
  vi.useRealTimers()
  await mod.closeAllAgentBrowsers()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  if (prevIdle === undefined) delete process.env['CLAWBOO_AGENT_BROWSER_IDLE_MS']
  else process.env['CLAWBOO_AGENT_BROWSER_IDLE_MS'] = prevIdle
})

describe('an agent browser on its own display', () => {
  it('starts with the display in its environment and lets go of it when it closes', async () => {
    await mod.agentBrowserSession(spec, 'conn', 'agent-1', { create: true })
    expect(seen.acquired).toHaveLength(1)
    const [agentId, holder] = seen.acquired[0]!
    expect(agentId).toBe('agent-1')
    expect(seen.envs[0]).toMatchObject({
      DISPLAY: ':42',
      XAUTHORITY: '/agent/desktops/x/Xauthority',
    })

    await mod.closeAgentBrowser('conn', 'agent-1')
    expect(seen.released).toContainEqual(['agent-1', holder])
  })

  it('lets go of the display when the browser dies on its own too', async () => {
    await mod.agentBrowserSession(spec, 'conn', 'agent-1', { create: true })
    const holder = seen.acquired[0]![1]
    seen.closers[0]!()
    expect(seen.released).toContainEqual(['agent-1', holder])
  })

  it('closes the browser when its display dies under it, so the next call starts afresh', async () => {
    await mod.agentBrowserSession(spec, 'conn', 'agent-1', { create: true })
    await mod.agentBrowserSession(spec, 'conn', 'agent-2', { create: true })
    for (const fn of displayListeners) fn('agent-1', null)
    await Promise.resolve()
    expect(mod.hasAgentBrowser('conn', 'agent-1')).toBe(false)
    expect(mod.hasAgentBrowser('conn', 'agent-2')).toBe(true)
  })

  it('starts as it always has where the agent gets no display', async () => {
    seen.display = null
    await mod.agentBrowserSession(spec, 'conn', 'agent-1', { create: true })
    expect(seen.envs[0]?.['DISPLAY']).not.toBe(':42')
    await mod.closeAgentBrowser('conn', 'agent-1')
    expect(seen.released).toEqual([])
  })

  it('holds one display per browser, so an old browser closing late frees nothing of a new one', async () => {
    await mod.agentBrowserSession(spec, 'conn', 'agent-1', { create: true })
    const oldClose = seen.closers[0]!
    await mod.closeAgentBrowser('conn', 'agent-1')
    await mod.agentBrowserSession(spec, 'conn', 'agent-1', { create: true })
    const [first, second] = seen.acquired.map(([, h]) => h)
    expect(first).not.toBe(second)
    seen.released.length = 0
    oldClose()
    expect(seen.released.every(([, h]) => h !== second)).toBe(true)
  })

  it('is not idled out while a person has taken over the screen', async () => {
    vi.useFakeTimers()
    await mod.agentBrowserSession(spec, 'conn', 'agent-1', { create: true })
    control.takeControl('agent-1', 'viewer', { kind: 'dashboard' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(mod.hasAgentBrowser('conn', 'agent-1')).toBe(true)
    control.releaseControl('agent-1', 'viewer')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(mod.hasAgentBrowser('conn', 'agent-1')).toBe(false)
  })
})
