// Opening OpenClaw while nothing uses its Gateway: the server connects, and the
// page brings up its own Gateway client once the server is connected, now or a
// little later (a Gateway that starts on its first connection can take longer
// than the server's answer waits). The watch outlives the Runtimes panel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { useConnectionStore } from '@/stores/connection'

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  health: vi.fn(),
  pageConnect: vi.fn(),
  enter: vi.fn(),
}))

vi.mock('@clawboo/control-client', async (orig) => ({
  ...(await orig<typeof import('@clawboo/control-client')>()),
  connectOpenClawGateway: h.connect,
  fetchRegistryHealth: h.health,
}))
vi.mock('@/lib/gatewayConnect', () => ({ connectGatewayFromSettings: h.pageConnect }))
vi.mock('@/features/connection/GatewayBootstrap', () => ({ enterGatewayMode: h.enter }))

import {
  OPENCLAW_WATCH_MS,
  OPENCLAW_WATCH_POLL_MS,
  cancelOpenClawWatch,
  openOpenClaw,
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
  useConnectionStore.setState({ status: 'connected', client: null })
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

  it('a failed page connect is swallowed: the server connection stands', async () => {
    h.connect.mockResolvedValue(health('connected'))
    h.pageConnect.mockRejectedValue(new Error('NOT_PAIRED'))
    await openOpenClaw()
    await vi.waitFor(() => expect(h.pageConnect).toHaveBeenCalledTimes(1))
    expect(h.enter).not.toHaveBeenCalled()
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
