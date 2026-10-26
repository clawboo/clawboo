// Where a new agent goes when nobody picked a runtime (Create Boo, the graph's
// New agent): OpenClaw while its Gateway is reachable from either end, else
// Clawboo Native, so an install with no Gateway can still make agents.

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
  it("is OpenClaw while this browser's Gateway client is connected, without asking the server", async () => {
    const fetchMock = stubServerConnection('disconnected')
    useConnectionStore.setState({ status: 'connected', client: {} as unknown as GatewayClient })
    expect(await defaultAgentSource()).toBe('openclaw')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("is OpenClaw for a thin client when the server's own Gateway connection is up", async () => {
    stubServerConnection('connected')
    useConnectionStore.setState({ status: 'connected', client: null })
    expect(await defaultAgentSource()).toBe('openclaw')
  })

  it('is Clawboo Native with no Gateway at either end (native mode)', async () => {
    const fetchMock = stubServerConnection('disconnected')
    useConnectionStore.setState({ status: 'connected', client: null })
    expect(await defaultAgentSource()).toBe('clawboo-native')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/agents/registry/health')
  })
})
