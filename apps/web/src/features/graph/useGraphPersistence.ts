'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useGraphStore } from './store'
import { useConnectionStore } from '@/stores/connection'
import type { LayoutData } from './types'

// ─── useGraphPersistence ──────────────────────────────────────────────────────
//
// Loads saved graph node positions from SQLite on mount (via GET /api/graph-layout)
// and writes them back on drag end (via POST /api/graph-layout, debounced 800ms).

export function useGraphPersistence() {
  const { setSavedPositions } = useGraphStore()
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load on mount / when connected gateway changes
  useEffect(() => {
    if (!gatewayUrl) return

    const url = `/api/graph-layout?name=default&url=${encodeURIComponent(gatewayUrl)}`
    void fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: LayoutData | null) => {
        if (data?.positions && Object.keys(data.positions).length > 0) {
          setSavedPositions(data.positions)
        }
      })
      .catch(() => {
        // Non-fatal — first run has no saved layout
      })
  }, [gatewayUrl, setSavedPositions])

  // Debounced save (called on node drag stop)
  const savePositions = useCallback(
    (positions: LayoutData['positions']) => {
      if (!gatewayUrl) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void fetch('/api/graph-layout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'default', positions, gatewayUrl }),
        }).catch(() => {
          // Non-fatal
        })
      }, 800)
    },
    [gatewayUrl],
  )

  return { savePositions }
}
