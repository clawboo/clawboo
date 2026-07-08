// enterGatewayMode — the dashboard OpenClawSetupFlow finalizer (the sibling of
// enterNativeMode for the OpenClaw path). It surfaces a freshly connected client
// to the connection store then hydrates (fleet from the LIVE client → teams →
// auto-migrate → approvals). Drives the REAL path against a fake GatewayClient +
// msw'd REST endpoints.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { GatewayClient } from '@clawboo/gateway-client'

import { server } from '@/__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { enterGatewayMode } from '../GatewayBootstrap'

type ListedAgent = { id: string; name?: string; identity?: { name?: string } }

function fakeClient(agents: ListedAgent[] = []): GatewayClient {
  return {
    agents: {
      list: async () => ({ defaultId: '', mainKey: 'main', scope: '', agents }),
    },
    disconnect: vi.fn(),
  } as unknown as GatewayClient
}

// Endpoints hit by the hydrate chain (with 0 agents: the registry read + model/exec
// maps + teams + approvals; auto-migrate returns early). Registered in beforeEach so
// both tests share them; the 1-agent test adds the boo-zero/sync/create-team endpoints.
// The `/api/agents` registry read is a fire-and-forget hydration call `enterGatewayMode`
// does not await, so it can land after the test settles; mocking it here keeps it from
// racing `afterEach`'s handler reset into an unhandled request (a flaky-run source).
beforeEach(() => {
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
  useFleetStore.setState({ agents: [] })
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  server.use(
    http.get('/api/agents', () =>
      HttpResponse.json({ defaultId: '', mainKey: 'main', agents: [], stale: false }),
    ),
    http.get('/api/system/openclaw-config', () => HttpResponse.json({})),
    http.get('/api/exec-settings/all', () => HttpResponse.json({})),
    http.get('/api/teams', () => HttpResponse.json({ teams: [] })),
    http.get('/api/approvals', () => HttpResponse.json({ records: [] })),
  )
})

describe('enterGatewayMode', () => {
  it('surfaces the client to the connection store (status/url/client) after hydrate', async () => {
    const client = fakeClient([])

    await enterGatewayMode(client, 'ws://localhost:18789')

    const s = useConnectionStore.getState()
    expect(s.status).toBe('connected')
    expect(s.gatewayUrl).toBe('ws://localhost:18789')
    expect(s.client).toBe(client)
  })

  it('disconnects a prior client before replacing it', async () => {
    const prev = fakeClient([])
    useConnectionStore.setState({ status: 'connected', client: prev, gatewayUrl: 'ws://old' })
    const next = fakeClient([])

    await enterGatewayMode(next, 'ws://localhost:18789')

    expect((prev as unknown as { disconnect: ReturnType<typeof vi.fn> }).disconnect).toHaveBeenCalled()
    expect(useConnectionStore.getState().client).toBe(next)
  })

  it('hydrates the fleet from the live client', async () => {
    server.use(
      http.get('/api/boo-zero/display-name/:id', () => HttpResponse.json({ name: 'Boo Zero' })),
      http.post('/api/agents/sync', () => HttpResponse.json({ ok: true })),
      // The single agent IS Boo Zero (no non-Boo-Zero unassigned agents), but with
      // no active team auto-migrate still mints a "Default" team.
      http.post('/api/teams', () =>
        HttpResponse.json({
          team: { id: 't1', name: 'Default', icon: '👻', color: '#059669' },
        }),
      ),
    )
    const client = fakeClient([{ id: 'a1', name: 'Test Boo', identity: { name: 'Test Boo' } }])

    await enterGatewayMode(client, 'ws://localhost:18789')

    expect(useFleetStore.getState().agents.map((a) => a.id)).toContain('a1')
    expect(useConnectionStore.getState().status).toBe('connected')
  })
})
