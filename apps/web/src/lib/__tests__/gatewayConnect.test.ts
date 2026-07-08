// connectGatewayFromSettings — the shared "connect via saved settings" helper the
// onboarding wizard AND the dashboard OpenClawSetupFlow both call. Node-project
// test: stub global `fetch` + mock the GatewayClient so no real WS is opened.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }))

vi.mock('@clawboo/gateway-client', () => ({
  GatewayClient: vi.fn(() => ({ connect: connectMock })),
  resolveProxyGatewayUrl: () => 'ws://proxy/api/gateway/ws',
}))

import { connectGatewayFromSettings } from '../gatewayConnect'

function stubSettings(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      status === 200
        ? new Response(JSON.stringify(body), { status })
        : new Response(null, { status }),
    ),
  )
}

describe('connectGatewayFromSettings', () => {
  beforeEach(() => {
    connectMock.mockReset()
    connectMock.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('connects via the proxy and returns { client, gatewayUrl } when settings have a url', async () => {
    stubSettings({ gatewayUrl: 'ws://localhost:18789' })

    const { client, gatewayUrl } = await connectGatewayFromSettings()

    expect(gatewayUrl).toBe('ws://localhost:18789')
    expect(client).toBeDefined()
    // Same-origin proxy + the exact options handleAllGood used — NOTE no authScopeKey.
    expect(connectMock).toHaveBeenCalledWith(
      'ws://proxy/api/gateway/ws',
      expect.objectContaining({
        clientName: 'openclaw-control-ui',
        clientVersion: '0.1.0',
        disableDeviceAuth: true,
      }),
    )
    expect(connectMock.mock.calls[0]?.[1]).not.toHaveProperty('authScopeKey')
  })

  it('trims the saved gatewayUrl', async () => {
    stubSettings({ gatewayUrl: '  ws://localhost:18789  ' })
    const { gatewayUrl } = await connectGatewayFromSettings()
    expect(gatewayUrl).toBe('ws://localhost:18789')
  })

  it('throws (and never connects) when settings have no gatewayUrl', async () => {
    stubSettings({})
    await expect(connectGatewayFromSettings()).rejects.toThrow()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('throws (and never connects) when /api/settings is not ok', async () => {
    stubSettings(null, 500)
    await expect(connectGatewayFromSettings()).rejects.toThrow()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('propagates a connect failure (e.g. NOT_PAIRED) so callers can branch/fall back', async () => {
    stubSettings({ gatewayUrl: 'ws://localhost:18789' })
    connectMock.mockRejectedValue(new Error('NOT_PAIRED'))
    await expect(connectGatewayFromSettings()).rejects.toThrow('NOT_PAIRED')
  })
})
