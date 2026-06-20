// Native-mode entry must not mark the app 'connected' BEFORE a guarded REST
// hydrate. A transient `/api/agents` 5xx (the server mid-restart) used to (a)
// flip status to 'connected' first and then (b) throw out of an un-caught REST
// hydrate, becoming an unhandled rejection that left the user on a blank screen.
//
// This drives the REAL path — `enterNativeMode` → `refreshFleetFromRegistry` →
// `listAgents` → `jsonOrThrow` (throws on non-2xx) — not an injected fake.

import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'

import { server } from '@/__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'

import { enterNativeMode } from '../GatewayBootstrap'

describe('enterNativeMode (native-mode guarded hydrate)', () => {
  beforeEach(() => {
    useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
  })

  it('marks connected ONLY after a successful registry hydrate', async () => {
    server.use(
      http.get('/api/agents', () =>
        HttpResponse.json({ defaultId: '', mainKey: 'main', agents: [], stale: false }),
      ),
      http.get('/api/teams', () => HttpResponse.json({ teams: [] })),
      http.get('/api/approvals', () => HttpResponse.json({ records: [] })),
    )

    const r = await enterNativeMode(null)

    expect(r.ok).toBe(true)
    expect(useConnectionStore.getState().status).toBe('connected')
  })

  it('a transient /api/agents 5xx → {ok:false}, NOT connected, and never throws', async () => {
    server.use(
      http.get('/api/agents', () => new HttpResponse(null, { status: 500 })),
      http.get('/api/teams', () => HttpResponse.json({ teams: [] })),
      http.get('/api/approvals', () => HttpResponse.json({ records: [] })),
    )

    // The call resolves (no unhandled rejection) and reports failure.
    const r = await enterNativeMode(null)

    expect(r.ok).toBe(false)
    expect(useConnectionStore.getState().status).not.toBe('connected')
  })
})
