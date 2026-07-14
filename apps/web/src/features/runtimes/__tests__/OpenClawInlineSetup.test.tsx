// OpenClawInlineSetup — the compact IN-PLACE OpenClaw setup. Verifies the two
// load-bearing behaviors: (1) it reuses an already-connected provider key (via
// auto-configure) and NEVER shows a key prompt; (2) it falls back to a compact
// key prompt only when nothing is connected. The gateway connect + enterGatewayMode
// are mocked (no real WebSocket in jsdom).

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { server } from '@/__vitest__/mswServer'
import { OpenClawInlineSetup } from '../OpenClawInlineSetup'

vi.mock('@/lib/gatewayConnect', () => ({
  connectGatewayFromSettings: vi.fn(async () => ({
    client: {} as GatewayClient,
    gatewayUrl: 'ws://localhost:18789',
  })),
}))
vi.mock('@/features/connection/GatewayBootstrap', () => ({
  enterGatewayMode: vi.fn(async () => {}),
}))

afterEach(() => cleanup())

describe('OpenClawInlineSetup', () => {
  it('reuses an existing key: auto-configure → start → connect (NO key prompt)', async () => {
    server.use(
      http.post('/api/system/auto-configure-openclaw', () =>
        HttpResponse.json({ ok: true, gatewayUrl: 'ws://localhost:18789', provider: 'anthropic' }),
      ),
      http.get('/api/system/status', () => HttpResponse.json({ openclaw: { installed: true } })),
      http.post(
        '/api/system/gateway',
        () =>
          new HttpResponse('data: {"type":"complete","success":true}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    )
    const onFinish = vi.fn()
    const onConnected = vi.fn()
    render(<OpenClawInlineSetup onFinish={onFinish} onCancel={vi.fn()} onConnected={onConnected} />)
    // Connects without ever asking for a key.
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('openclaw-inline-key')).not.toBeInTheDocument()
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1), { timeout: 2000 })
  })

  it('falls back to a compact key prompt when no provider is connected', async () => {
    server.use(
      http.post('/api/system/auto-configure-openclaw', () =>
        HttpResponse.json({ ok: false, needsKey: true }),
      ),
    )
    render(<OpenClawInlineSetup onFinish={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByTestId('openclaw-inline-key')).toBeInTheDocument()
  })
})
