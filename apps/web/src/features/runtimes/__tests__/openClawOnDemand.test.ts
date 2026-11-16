// Opening OpenClaw while nothing uses its Gateway: the server connects, and the
// page brings up its own Gateway client once the server is connected, now or a
// little later (a Gateway that starts on its first connection can take longer
// than the server's answer waits). The watch outlives the Runtimes panel. A
// server something else connected gets the page's client from the connected
// row's Connect this page (connectThisPage), through the same shared dial.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  health: vi.fn(),
  pageConnect: vi.fn(),
  enter: vi.fn(),
  thin: vi.fn(),
}))

vi.mock('@clawboo/control-client', async (orig) => ({
  ...(await orig<typeof import('@clawboo/control-client')>()),
  connectOpenClawGateway: h.connect,
  fetchRegistryHealth: h.health,
}))
vi.mock('@/lib/gatewayConnect', () => ({ connectGatewayFromSettings: h.pageConnect }))
vi.mock('@/features/connection/GatewayBootstrap', () => ({ enterGatewayMode: h.enter }))
vi.mock('@/lib/thinClient', () => ({ isThinClient: h.thin }))

import {
  OPENCLAW_WATCH_MS,
  OPENCLAW_WATCH_POLL_MS,
  PAGE_CLIENT_FAILED,
  cancelOpenClawWatch,
  connectThisPage,
  isPageAttaching,
  openOpenClaw,
  subscribePageAttach,
} from '../openClawOnDemand'

const live = {} as unknown as GatewayClient
const health = (connection: string) => ({
  ok: connection === 'connected',
  connection,
  lastSyncedAt: null,
  inUse: true,
  configured: true,
})

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(h)) fn.mockReset()
  h.pageConnect.mockResolvedValue({ client: live, gatewayUrl: 'ws://localhost:18789' })
  h.enter.mockResolvedValue(undefined)
  h.thin.mockReturnValue(false)
  useConnectionStore.setState({ status: 'connected', client: null })
  useToastStore.setState({ toasts: [] })
})
afterEach(() => {
  cancelOpenClawWatch()
  vi.useRealTimers()
})

describe('openOpenClaw', () => {
  it('brings up the page client at once when the server answers connected', async () => {
    h.connect.mockResolvedValue(health('connected'))
    await openOpenClaw()
    await vi.waitFor(() => expect(h.enter).toHaveBeenCalledWith(live, 'ws://localhost:18789'))
    expect(h.health).not.toHaveBeenCalled()
  })

  it('a Gateway still starting gets the page client once a later read finds it connected', async () => {
    h.connect.mockResolvedValue(health('connecting'))
    h.health.mockResolvedValueOnce(health('connecting')).mockResolvedValue(health('connected'))
    expect((await openOpenClaw()).connection).toBe('connecting')
    expect(h.pageConnect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(OPENCLAW_WATCH_POLL_MS)
    expect(h.health).toHaveBeenCalledTimes(1)
    expect(h.pageConnect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(OPENCLAW_WATCH_POLL_MS)
    expect(h.health).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(h.enter).toHaveBeenCalledTimes(1))
    expect(h.pageConnect).toHaveBeenCalledTimes(1)
  })

  it('gives up after the watch window when the server never connects', async () => {
    h.connect.mockResolvedValue(health('disconnected'))
    h.health.mockResolvedValue(health('disconnected'))
    await openOpenClaw()
    await vi.advanceTimersByTimeAsync(OPENCLAW_WATCH_MS + 5 * OPENCLAW_WATCH_POLL_MS)
    const reads = h.health.mock.calls.length
    expect(reads).toBeLessThanOrEqual(OPENCLAW_WATCH_MS / OPENCLAW_WATCH_POLL_MS + 1)
    await vi.advanceTimersByTimeAsync(10 * OPENCLAW_WATCH_POLL_MS)
    expect(h.health.mock.calls.length).toBe(reads)
    expect(h.pageConnect).not.toHaveBeenCalled()
  })

  it('leaves a page that already has a client alone', async () => {
    useConnectionStore.setState({ status: 'connected', client: live })
    h.connect.mockResolvedValue(health('connected'))
    await openOpenClaw()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.pageConnect).not.toHaveBeenCalled()
  })

  it('a failed page connect points at Connect this page, not a reload', async () => {
    h.connect.mockResolvedValue(health('connected'))
    h.pageConnect.mockRejectedValue(new Error('NOT_PAIRED'))
    await openOpenClaw()
    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([PAGE_CLIENT_FAILED]),
    )
    expect(PAGE_CLIENT_FAILED).toMatch(/Connect this page/)
    expect(PAGE_CLIENT_FAILED).toMatch(/Settings > Runtimes/)
    expect(PAGE_CLIENT_FAILED).not.toMatch(/reload/i)
    expect(h.enter).not.toHaveBeenCalled()
  })

  it('a thin client never dials a page connection of its own', async () => {
    h.thin.mockReturnValue(true)
    h.connect.mockResolvedValue(health('connected'))
    await openOpenClaw()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.pageConnect).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('a second open while the page dial is in flight shares it rather than dialing again', async () => {
    h.connect.mockResolvedValue(health('connected'))
    let land: (v: { client: GatewayClient; gatewayUrl: string }) => void = () => {}
    h.pageConnect.mockImplementation(() => new Promise((resolve) => (land = resolve)))
    await openOpenClaw()
    await vi.waitFor(() => expect(h.pageConnect).toHaveBeenCalledTimes(1))
    await openOpenClaw()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.pageConnect).toHaveBeenCalledTimes(1)

    land({ client: live, gatewayUrl: 'ws://localhost:18789' })
    await vi.waitFor(() => expect(h.enter).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.enter).toHaveBeenCalledTimes(1)
  })

  it('a second open replaces the first watch rather than running two', async () => {
    h.connect.mockResolvedValue(health('connecting'))
    h.health.mockResolvedValue(health('connecting'))
    await openOpenClaw()
    await openOpenClaw()
    await vi.advanceTimersByTimeAsync(OPENCLAW_WATCH_POLL_MS)
    expect(h.health).toHaveBeenCalledTimes(1)
  })
})

describe('connectThisPage', () => {
  it('brings up the page client for a server already connected, asking the server nothing', async () => {
    await connectThisPage()
    expect(h.pageConnect).toHaveBeenCalledTimes(1)
    expect(h.enter).toHaveBeenCalledWith(live, 'ws://localhost:18789')
    expect(h.connect).not.toHaveBeenCalled()
    expect(h.health).not.toHaveBeenCalled()
  })

  it('shares a dial in flight, so two calls dial once', async () => {
    let land: (v: { client: GatewayClient; gatewayUrl: string }) => void = () => {}
    h.pageConnect.mockImplementation(() => new Promise((resolve) => (land = resolve)))
    const first = connectThisPage()
    const second = connectThisPage()
    land({ client: live, gatewayUrl: 'ws://localhost:18789' })
    await Promise.all([first, second])
    expect(h.pageConnect).toHaveBeenCalledTimes(1)
    expect(h.enter).toHaveBeenCalledTimes(1)
  })

  it('shares the dial a watch started, rather than dialing again', async () => {
    h.connect.mockResolvedValue(health('connected'))
    let land: (v: { client: GatewayClient; gatewayUrl: string }) => void = () => {}
    h.pageConnect.mockImplementation(() => new Promise((resolve) => (land = resolve)))
    await openOpenClaw()
    await vi.waitFor(() => expect(h.pageConnect).toHaveBeenCalledTimes(1))
    const pending = connectThisPage()
    land({ client: live, gatewayUrl: 'ws://localhost:18789' })
    await pending
    expect(h.pageConnect).toHaveBeenCalledTimes(1)
    expect(h.enter).toHaveBeenCalledTimes(1)
  })

  it('ends a watch still waiting, so a failed page connect is not dialed and told twice', async () => {
    h.connect.mockResolvedValue(health('connecting'))
    h.health.mockResolvedValue(health('connected'))
    h.pageConnect.mockRejectedValue(new Error('NOT_PAIRED'))
    // Every toast as it is added: a toast expires on its own timer, which the
    // advance below runs.
    const told: string[] = []
    const stop = useToastStore.subscribe((s, prev) => {
      if (s.toasts.length > prev.toasts.length) told.push(s.toasts[s.toasts.length - 1]!.message)
    })
    await openOpenClaw()
    await connectThisPage()
    expect(h.pageConnect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3 * OPENCLAW_WATCH_POLL_MS)
    stop()
    expect(h.pageConnect).toHaveBeenCalledTimes(1)
    expect(told).toEqual([PAGE_CLIENT_FAILED])
  })

  it('leaves a page that already has a client alone', async () => {
    useConnectionStore.setState({ status: 'connected', client: live })
    await connectThisPage()
    expect(h.pageConnect).not.toHaveBeenCalled()
  })

  it('does nothing in a thin client', async () => {
    h.thin.mockReturnValue(true)
    await connectThisPage()
    expect(h.pageConnect).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('keeps a client another path gave the page while the dial ran', async () => {
    // The offline banner's Reconnect, say, landed first. Entering this dial's
    // client would disconnect that one and load the fleet a second time.
    const fresh = { disconnect: vi.fn() } as unknown as GatewayClient
    let land: (v: { client: GatewayClient; gatewayUrl: string }) => void = () => {}
    h.pageConnect.mockImplementation(() => new Promise((resolve) => (land = resolve)))
    const pending = connectThisPage()
    useConnectionStore.setState({ client: live })
    land({ client: fresh, gatewayUrl: 'ws://localhost:18789' })
    await pending
    expect(fresh.disconnect).toHaveBeenCalledTimes(1)
    expect(h.enter).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().client).toBe(live)
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('a dial that fails after another path gave the page a client says nothing', async () => {
    // The offline banner's Reconnect landed while this dial ran, then this one
    // failed. The page is connected, and the row offers no Connect this page.
    let fail: (err: Error) => void = () => {}
    h.pageConnect.mockImplementation(() => new Promise((_, reject) => (fail = reject)))
    const pending = connectThisPage()
    useConnectionStore.setState({ client: live })
    fail(new Error('NOT_PAIRED'))
    await pending
    expect(h.enter).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().client).toBe(live)
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('entering the client failing after it was set says nothing either', async () => {
    // enterGatewayMode sets the client before it loads the fleet, so a throw
    // from that load leaves the page connected.
    h.enter.mockImplementation(async (client: GatewayClient) => {
      useConnectionStore.setState({ client })
      throw new Error('fleet load failed')
    })
    await connectThisPage()
    expect(useConnectionStore.getState().client).toBe(live)
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('tells listeners when a page dial starts and ends, so the row can show it busy', async () => {
    let land: (v: { client: GatewayClient; gatewayUrl: string }) => void = () => {}
    h.pageConnect.mockImplementation(() => new Promise((resolve) => (land = resolve)))
    const seen: boolean[] = []
    const stop = subscribePageAttach(() => seen.push(isPageAttaching()))
    expect(isPageAttaching()).toBe(false)
    const pending = connectThisPage()
    expect(isPageAttaching()).toBe(true)
    land({ client: live, gatewayUrl: 'ws://localhost:18789' })
    await pending
    stop()
    expect(isPageAttaching()).toBe(false)
    expect(seen).toEqual([true, false])
  })
})
