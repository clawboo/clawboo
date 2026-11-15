// A dashboard load must not wake an OpenClaw Gateway nothing uses.
//
// The server connects to the Gateway on demand, and reports `gateway.inUse:
// false` until something needs it (an OpenClaw agent, opening OpenClaw in
// Runtimes, an OpenClaw routine). The page used to auto-connect through the
// Gateway proxy on every load whenever OpenClaw was set up, and that connection
// alone starts a Gateway that a service manager starts on its first connection.
// So a load with nothing using OpenClaw enters the dashboard without the Gateway,
// and shows neither the offline overlay nor the reconnect banner: a Gateway
// nobody uses is not one that is down.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { GatewayClient } from '@clawboo/gateway-client'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { GatewayBootstrap } from '../GatewayBootstrap'

function systemInfo(gateway: { running: boolean; inUse: boolean }) {
  return {
    node: { version: 'v24.22.1', major: 24, sufficient: true, path: '/usr/bin/node' },
    openclaw: {
      installed: true,
      version: '2026.9.37',
      path: '/usr/bin/openclaw',
      stateDir: '/tmp/.openclaw',
      configExists: true,
      envExists: true,
    },
    gateway: { ...gateway, port: 18789, pid: null, managedByClawboo: false, uptimeMs: null },
  }
}

let teamsHits = 0
// Every Gateway connection the page opens goes through GatewayClient.connect,
// to the same-origin proxy that dials the Gateway.
let connects: MockInstance<GatewayClient['connect']>

beforeEach(() => {
  teamsHits = 0
  connects = vi
    .spyOn(GatewayClient.prototype, 'connect')
    .mockRejectedValue(new Error('no Gateway in this test'))
  localStorage.setItem('clawboo.onboarded', '1')
  localStorage.removeItem('clawboo.wizard.active')
  localStorage.setItem('clawboo.tour.shown', '1')
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
  useFleetStore.setState({ agents: [] })
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  server.use(
    http.get('/api/settings', () =>
      HttpResponse.json({ gatewayUrl: 'ws://localhost:18789', hasToken: true }),
    ),
    http.get('/api/teams', () => {
      teamsHits += 1
      return HttpResponse.json({ teams: [] })
    }),
    http.get('/api/approvals', () => HttpResponse.json({ records: [] })),
  )
})

afterEach(() => {
  cleanup()
  connects.mockRestore()
  localStorage.clear()
})

describe('GatewayBootstrap with OpenClaw set up and not in use', () => {
  it('enters the dashboard without connecting, and shows no offline overlay or banner', async () => {
    server.use(
      http.get('/api/system/status', () =>
        HttpResponse.json(systemInfo({ running: false, inUse: false })),
      ),
    )
    render(<GatewayBootstrap />)

    await waitFor(() => expect(useConnectionStore.getState().status).toBe('connected'))
    // Native mode: the dashboard is up with no Gateway client.
    expect(useConnectionStore.getState().client).toBeNull()
    // No connection through the proxy, so no Gateway was woken for this load.
    expect(connects).not.toHaveBeenCalled()
    expect(screen.queryByText('Gateway Offline')).not.toBeInTheDocument()
    expect(screen.queryByTestId('gateway-reconnect-banner')).not.toBeInTheDocument()
  })

  it('with the status unreadable, asks the registry and does not dial a Gateway not in use', async () => {
    server.use(
      http.get('/api/system/status', () => new HttpResponse(null, { status: 503 })),
      http.get('/api/agents/registry/health', () =>
        HttpResponse.json({
          ok: false,
          connection: 'disconnected',
          lastSyncedAt: null,
          inUse: false,
          configured: true,
        }),
      ),
    )
    render(<GatewayBootstrap />)

    await waitFor(() => expect(useConnectionStore.getState().status).toBe('connected'))
    expect(useConnectionStore.getState().client).toBeNull()
    expect(connects).not.toHaveBeenCalled()
  })

  it('still auto-connects once the Gateway is in use', async () => {
    server.use(
      http.get('/api/system/status', () =>
        HttpResponse.json(systemInfo({ running: true, inUse: true })),
      ),
    )
    render(<GatewayBootstrap />)

    await waitFor(() => expect(teamsHits).toBeGreaterThan(0))
    await waitFor(() => expect(connects).toHaveBeenCalledTimes(1))
  })
})
