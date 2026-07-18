// @vitest-environment jsdom
//
// Regression guard: the Ghost Graph must lay out (and therefore RENDER) without
// an OpenClaw Gateway. `useGraphPersistence` used to early-return when
// `!gatewayUrl`, which left `isLoaded` stuck at `false` in native mode — and
// `GhostGraph` gates its ELK layout on `isLoaded`, so the layout never ran,
// `hasRunLayout` stayed false, and the graph wrapper sat at `opacity: 0`. Net
// symptom: the Ghost Graph appeared ONLY once an OpenClaw Gateway was connected
// (a URL was set) and vanished the moment it disconnected. Native mode has no
// Gateway, so it keys layouts under the empty ('') url — a valid scope key the
// server GET/POST both accept.

import { renderHook, waitFor, act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import { useGraphPersistence } from '../useGraphPersistence'

beforeEach(() => {
  // Native mode: no Gateway → gatewayUrl is '' (enterNativeMode sets it empty).
  useConnectionStore.setState({ gatewayUrl: '' })
  useTeamStore.setState({ selectedTeamId: null })
})

afterEach(() => {
  useConnectionStore.setState({ gatewayUrl: null })
})

describe('useGraphPersistence — the graph renders without a Gateway (native mode)', () => {
  it('loads (isLoaded → true) instead of skipping when gatewayUrl is empty', async () => {
    let requestedUrl: string | null = null
    server.use(
      http.get('/api/graph-layout', ({ request }) => {
        requestedUrl = request.url
        return HttpResponse.json({ positions: {} })
      }),
    )

    const { result } = renderHook(() => useGraphPersistence('team'))

    // The load must resolve — without this, GhostGraph never runs ELK.
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    // It did NOT early-return: it fetched under the empty-url scope key.
    expect(requestedUrl).toContain('/api/graph-layout')
    expect(requestedUrl).toContain('url=')
  })

  it('persists positions under the empty-url scope key (POST fires in native mode)', async () => {
    let posted: { gatewayUrl?: string } | null = null
    server.use(
      http.get('/api/graph-layout', () => HttpResponse.json({ positions: {} })),
      http.post('/api/graph-layout', async ({ request }) => {
        posted = (await request.json()) as { gatewayUrl?: string }
        return HttpResponse.json({ ok: true })
      }),
    )

    const { result } = renderHook(() => useGraphPersistence('team'))
    await waitFor(() => expect(result.current.isLoaded).toBe(true))

    act(() => {
      result.current.savePositions({ 'boo-1': { x: 10, y: 20 } })
    })

    // Debounced 800ms — waitFor polls until the POST lands.
    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 2000 })
    expect(posted?.gatewayUrl).toBe('')
  })
})
