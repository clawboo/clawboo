import { useCallback, useEffect, useRef, useState } from 'react'
import { useGraphStore } from './store'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import type { LayoutData, GhostGraphScope } from './types'

// ─── useGraphPersistence ──────────────────────────────────────────────────────
//
// Loads saved graph node positions from SQLite on mount (via GET /api/graph-layout)
// and writes them back on drag end (via POST /api/graph-layout, debounced 800ms).
// Positions are scoped per-team AND per-scope so switching teams / switching
// between Atlas and a team's Ghost Graph loads the correct layout.
//
// **Scope-aware layoutName is load-bearing**: previously the layoutName was
// just `team-${selectedTeamId}`. The sidebar's selected team is preserved
// when entering Atlas, so opening Atlas with team A still in the sidebar
// would save Atlas's positions under `team-${A}` — which is the same key
// the team-A Ghost Graph uses. The team Ghost Graph would then load
// Atlas's positions on next open, applying Boo-Zero-far-off-to-the-right
// + spread-out team-boos coordinates to its team-scoped subset. Re-layout
// in the team chat fixed it temporarily, but any subsequent Atlas visit
// would overwrite the fix. Splitting the key by scope (atlas vs team)
// keeps the two layouts independent.

export function useGraphPersistence(scope: GhostGraphScope = 'team') {
  const { setSavedPositions } = useGraphStore()
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)

  const layoutName =
    scope === 'atlas' ? 'atlas' : selectedTeamId ? `team-${selectedTeamId}` : 'default'

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
