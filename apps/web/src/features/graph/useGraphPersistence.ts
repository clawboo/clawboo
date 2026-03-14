import { useCallback, useEffect, useRef, useState } from 'react'
import { useGraphStore } from './store'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import type { LayoutData } from './types'

// ─── useGraphPersistence ──────────────────────────────────────────────────────
//
// Loads saved graph node positions from SQLite on mount (via GET /api/graph-layout)
// and writes them back on drag end (via POST /api/graph-layout, debounced 800ms).
// Positions are scoped per-team so switching teams loads the correct layout.

export function useGraphPersistence() {
  const { setSavedPositions } = useGraphStore()
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)

  const layoutName = selectedTeamId ? `team-${selectedTeamId}` : 'default'

  // Load on mount / when connected gateway or team changes
  useEffect(() => {
    if (!gatewayUrl) return
    setIsLoaded(false) // Reset on team switch — wait for fresh positions

    const url = `/api/graph-layout?name=${encodeURIComponent(layoutName)}&url=${encodeURIComponent(gatewayUrl)}`
    void fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: LayoutData | null) => {
        if (data?.positions && Object.keys(data.positions).length > 0) {
          setSavedPositions(data.positions)
        }
        setIsLoaded(true)
      })
      .catch(() => {
        // Non-fatal — first run has no saved layout
        setIsLoaded(true)
      })
  }, [gatewayUrl, selectedTeamId, layoutName, setSavedPositions])

  // Debounced save (called on node drag stop)
  const savePositions = useCallback(
    (positions: LayoutData['positions']) => {
      if (!gatewayUrl) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void fetch('/api/graph-layout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: layoutName, positions, gatewayUrl }),
        }).catch(() => {
          // Non-fatal
        })
      }, 800)
    },
    [gatewayUrl, layoutName],
  )

  return { savePositions, isLoaded }
}
