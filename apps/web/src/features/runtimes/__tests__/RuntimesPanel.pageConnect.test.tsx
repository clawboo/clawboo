// Connect this page: a page that loaded while OpenClaw was not in use has no
// Gateway client of its own, and when something else connects the server later
// (a routine, another page opening OpenClaw), the OpenClaw row reads Connected
// while this page's OpenClaw chats cannot send. The connected row then offers
// Connect this page, which brings up the page's client through the shared dial
// in openClawOnDemand. A thin client never gets the action: it has no page client
// by design. RTL pattern (msw onUnhandledRequest: 'error'); no socket.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { cancelOpenClawWatch, connectThisPage } from '../openClawOnDemand'
import { RuntimesPanel } from '../RuntimesPanel'

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  enter: vi.fn(),
  thin: vi.fn(),
}))
vi.mock('@/lib/gatewayConnect', () => ({ connectGatewayFromSettings: h.connect }))
vi.mock('@/features/connection/GatewayBootstrap', () => ({ enterGatewayMode: h.enter }))
vi.mock('@/lib/thinClient', () => ({ isThinClient: h.thin }))

const live = {} as unknown as GatewayClient
const PAGE_ACTION = 'runtime-openclaw-connect-page'

type Health = Record<string, unknown>
const CONNECTED: Health = {
  ok: true,
  connection: 'connected',
  lastSyncedAt: 1,
  inUse: true,
  configured: true,
}
const OFFLINE: Health = {
  ok: false,
  connection: 'disconnected',
  lastSyncedAt: null,
  inUse: true,
  configured: true,
}

let health: Health = CONNECTED
let connects = 0

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.thin.mockReturnValue(false)
  h.connect.mockResolvedValue({ client: live, gatewayUrl: 'ws://localhost:18789' })
  // As the real one does: the page's client lands in the store.
  h.enter.mockImplementation(async (client: GatewayClient) => {
    useConnectionStore.setState({ client })
  })
  // The dashboard loaded in native mode (OpenClaw was not in use then).
  useConnectionStore.setState({ status: 'connected', client: null })
  useToastStore.setState({ toasts: [] })
  health = CONNECTED
  connects = 0
  server.use(
    http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
    http.get('/api/system/openclaw-config', () =>
      HttpResponse.json({ config: { gateway: { port: 18789 } }, env: {}, version: null }),
    ),
    http.get('/api/agents/registry/health', () => HttpResponse.json(health)),
    http.post('/api/agents/registry/connect', () => {
      connects += 1
      return HttpResponse.json(health)
    }),
  )
})
afterEach(() => {
  cleanup()
  cancelOpenClawWatch()
})

describe('Connect this page on the connected OpenClaw row', () => {
  it('shows only while the server is connected and this page has no client of its own', async () => {
    // The server has no connection: the row reads Disconnected, nothing to offer.
    health = OFFLINE
    render(<RuntimesPanel />)
    expect(await screen.findByText('Disconnected')).toBeInTheDocument()
    expect(screen.queryByTestId(PAGE_ACTION)).not.toBeInTheDocument()

    // Something else connects the server; the next read shows it.
    health = CONNECTED
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    const action = await screen.findByTestId(PAGE_ACTION)
    expect(action).toHaveAccessibleName('Connect this page to OpenClaw')
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
    // Showing it is not a dial, and not a need either.
    expect(h.connect).not.toHaveBeenCalled()
    expect(connects).toBe(0)

    // The page gets a client of its own some other way: nothing left to offer.
    act(() => useConnectionStore.setState({ client: live }))
    await waitFor(() => expect(screen.queryByTestId(PAGE_ACTION)).not.toBeInTheDocument())
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
  })

  it('attaches the page client once, even on a double click', async () => {
    let land: (v: { client: GatewayClient; gatewayUrl: string }) => void = () => {}
    h.connect.mockImplementation(() => new Promise((resolve) => (land = resolve)))
    render(<RuntimesPanel />)
    const action = await screen.findByTestId(PAGE_ACTION)

    await userEvent.dblClick(action)
    await waitFor(() => expect(h.connect).toHaveBeenCalledTimes(1))
    expect(action).toBeDisabled()
    // A click on a button that is busy (or one that slips through) shares the dial.
    await userEvent.click(action)
    expect(h.connect).toHaveBeenCalledTimes(1)

    await act(async () => land({ client: live, gatewayUrl: 'ws://localhost:18789' }))
    await waitFor(() => expect(h.enter).toHaveBeenCalledWith(live, 'ws://localhost:18789'))
    expect(h.enter).toHaveBeenCalledTimes(1)
    expect(h.connect).toHaveBeenCalledTimes(1)
    // The page has its client now, so the row offers nothing more.
    await waitFor(() => expect(screen.queryByTestId(PAGE_ACTION)).not.toBeInTheDocument())
    // A page connect never asks the server to connect: it already is.
    expect(connects).toBe(0)
  })

  it('is absent in a thin client, where a page never has a client of its own', async () => {
    // The same state on a page served by the server it talks to offers it.
    render(<RuntimesPanel />)
    expect(await screen.findByTestId(PAGE_ACTION)).toBeInTheDocument()
    cleanup()

    // A thin client (its control client points at a server on another origin)
    // reads OpenClaw connected from the server, and offers nothing for the page.
    h.thin.mockReturnValue(true)
    render(<RuntimesPanel />)
    await waitFor(() => expect(screen.getAllByText('Connected').length).toBeGreaterThan(0))
    expect(screen.getByTestId('runtime-list-row-openclaw-toggle')).toHaveAccessibleName(
      /manage openclaw/i,
    )
    expect(screen.queryByTestId(PAGE_ACTION)).not.toBeInTheDocument()
    expect(h.connect).not.toHaveBeenCalled()
  })

  it('a failed attach says what to do, and the action stays to try again', async () => {
    h.connect.mockRejectedValue(new Error('NOT_PAIRED'))
    render(<RuntimesPanel />)

    await userEvent.click(await screen.findByTestId(PAGE_ACTION))

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    const [toast] = useToastStore.getState().toasts
    expect(toast?.type).toBe('error')
    expect(toast?.message).toMatch(/this page could not connect/i)
    // It points at the action, not at a reload.
    expect(toast?.message).toMatch(/Connect this page/)
    expect(toast?.message).toMatch(/Settings > Runtimes/)
    expect(toast?.message).not.toMatch(/reload/i)
    expect(h.enter).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId(PAGE_ACTION)).toBeEnabled())

    h.connect.mockResolvedValue({ client: live, gatewayUrl: 'ws://localhost:18789' })
    await userEvent.click(screen.getByTestId(PAGE_ACTION))
    await waitFor(() => expect(h.enter).toHaveBeenCalledTimes(1))
    expect(h.connect).toHaveBeenCalledTimes(2)
  })

  it('shows busy, not idle, while a page dial from elsewhere is running', async () => {
    // The watch after opening a Not in use row, say, is dialing already.
    let land: (v: { client: GatewayClient; gatewayUrl: string }) => void = () => {}
    h.connect.mockImplementation(() => new Promise((resolve) => (land = resolve)))
    const dialing = connectThisPage()
    render(<RuntimesPanel />)

    const action = await screen.findByTestId(PAGE_ACTION)
    expect(action).toBeDisabled()
    expect(action).toHaveTextContent('Connecting…')
    expect(h.connect).toHaveBeenCalledTimes(1)

    await act(async () => {
      land({ client: live, gatewayUrl: 'ws://localhost:18789' })
      await dialing
    })
    await waitFor(() => expect(screen.queryByTestId(PAGE_ACTION)).not.toBeInTheDocument())
    expect(h.connect).toHaveBeenCalledTimes(1)
  })
})
