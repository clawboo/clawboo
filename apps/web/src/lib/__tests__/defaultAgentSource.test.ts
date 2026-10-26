// Where a new agent goes when nobody picked a runtime (Create Boo, the graph's
// New agent): OpenClaw while the server's Gateway connection is up, else
// Clawboo Native, so an install with no Gateway can still make agents. The
// server's connection decides, because the server is what creates the agent.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { useConnectionStore } from '@/stores/connection'

import { defaultAgentSource } from '../defaultAgentSource'

/** Answer the registry-health read with the server's OpenClaw connection state. */
function stubServerConnection(connection: 'connected' | 'disconnected') {
  const fetchMock = vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: connection === 'connected', connection, lastSyncedAt: null }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
})

describe('defaultAgentSource', () => {
  it("is OpenClaw while the server's Gateway connection is up", async () => {
    const fetchMock = stubServerConnection('connected')
    useConnectionStore.setState({ status: 'connected', client: null })
    expect(await defaultAgentSource()).toBe('openclaw')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/agents/registry/health')
  })

  it('is Clawboo Native with no Gateway (native mode)', async () => {
    stubServerConnection('disconnected')
    useConnectionStore.setState({ status: 'connected', client: null })
    expect(await defaultAgentSource()).toBe('clawboo-native')
  })

  // The browser's own connection cannot create anything: an OpenClaw create
  // would go through the server's Gateway client, which is down, and 503.
  it("is Clawboo Native while only this browser's Gateway connection is up", async () => {
    stubServerConnection('disconnected')
    useConnectionStore.setState({ status: 'connected', client: {} as unknown as GatewayClient })
    expect(await defaultAgentSource()).toBe('clawboo-native')
  })
})
