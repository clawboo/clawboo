import { useCallback, useEffect, useRef, useState } from 'react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import {
  Brain,
  Lock,
  LockOpen,
  // Aliased: a bare `Map` import shadows the global Map constructor below.
  Map as MapIcon,
  Maximize2,
  Pin,
  RefreshCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { BarBtn, BarDivider } from '@/features/graph/toolbar'
import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { SearchInput } from '@/features/shared/SearchInput'
import { SegmentedControl } from '@/features/shared/SegmentedControl'
import { StatusPill } from '@/features/shared/StatusPill'
import { searchMemory, type SearchMode } from '@/lib/memoryClient'
import { InspectPanel } from './InspectPanel'
import { LegendPanel } from './LegendPanel'
import { MemoryGraphCanvas } from './MemoryGraphCanvas'
import { useMemoryGraphStore, type MemScopeFilter, type MemTimeFilter } from './store'

// ─── MemoryGraphView — the hero shell (canvas + docked chrome) ───────────────
//
// Search bar (top-left): typing = 150ms-debounced substring dim; Enter = a
// real store search (fts/vector/hybrid) whose hits light up score-weighted as
// an ego-graph — "what does the team know about X". Command bar (top-right):
// Re-layout (refetch + fresh ELK), hull toggle, scope + time filters. Viewport
// bar (bottom-right) mirrors GhostGraph. Honesty pills surface the truncation
// cap and the no-embedding-provider degrade — no silent caps.

const MODES: SearchMode[] = ['fts', 'vector', 'hybrid']

const SCOPE_OPTIONS: { id: MemScopeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'global', label: 'Global' },
  { id: 'team', label: 'Team' },
  { id: 'agent', label: 'Agent' },
]

const TIME_OPTIONS: { id: MemTimeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
]

function MemoryGraphViewInner({ onOpenList }: { onOpenList?: (() => void) | undefined }) {
  const payload = useMemoryGraphStore((s) => s.payload)
  const provider = useMemoryGraphStore((s) => s.provider)
  const loading = useMemoryGraphStore((s) => s.loading)
  const error = useMemoryGraphStore((s) => s.error)
  const showHulls = useMemoryGraphStore((s) => s.showHulls)
  const scopeFilter = useMemoryGraphStore((s) => s.scopeFilter)
  const selectedNodeId = useMemoryGraphStore((s) => s.selectedNodeId)
  const timeFilter = useMemoryGraphStore((s) => s.timeFilter)
  const locked = useMemoryGraphStore((s) => s.locked)
  const showMinimap = useMemoryGraphStore((s) => s.showMinimap)

  const { fitView, zoomIn, zoomOut } = useReactFlow()

  // Stale selections must never leak across visits.
  useEffect(() => () => useMemoryGraphStore.getState().reset(), [])

  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [noMatch, setNoMatch] = useState(false)

  // Debounced live substring dim (150ms — fast enough to feel live, slow
  // enough to skip intermediate keystrokes).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onQueryChange = useCallback((v: string) => {
    setQuery(v)
    setNoMatch(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const store = useMemoryGraphStore.getState()
      store.setSearchText(v)
      // Typing always resumes live substring dimming — drop any ego set a prior
      // Enter-search left behind, so the graph doesn't stay stuck in ego mode.
      store.setEgoHits(null)
    }, 150)
  }, [])
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

  // Keep the input in sync when chrome elsewhere pivots the search (tag chips).
  const searchText = useMemoryGraphStore((s) => s.searchText)
  useEffect(() => {
    setQuery((prev) => (prev === searchText ? prev : searchText))
  }, [searchText])

  const runEgoSearch = useCallback(async () => {
    // Cancel a pending substring-dim so it can't race this ego set to null.
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const store = useMemoryGraphStore.getState()
    const q = query.trim()
    if (!q || !store.payload) return
    const results = await searchMemory(q, mode, { limit: 25 })
    const nodeIds = new Set(store.payload.nodes.map((n) => n.id))
    const hits = new Map<string, number>()
    for (const r of results) {
      if (nodeIds.has(r.id)) hits.set(r.id, r.score)
    }
    if (hits.size === 0) {
      // Zero hits must NOT set an empty ego Map — that dims every node to a
      // blackout. Clear it (full intensity) and surface a "No matches" pill.
      store.setEgoHits(null)
      setNoMatch(true)
      return
    }
    setNoMatch(false)
    store.setEgoHits(hits)
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1])
    store.select(ranked[0]![0]) // top hit auto-opens the inspector
    void fitView({
      padding: 0.25,
      duration: 500,
      nodes: ranked.map(([id]) => ({ id })),
    })
  }, [query, mode, fitView])

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') void runEgoSearch()
      if (e.key === 'Escape') {
        setQuery('')
        useMemoryGraphStore.getState().clearSearch()
      }
    },
    [runEgoSearch],
  )

  const factNodeCount = payload?.nodes.filter((n) => n.kind === 'fact').length ?? 0
  const procNodeCount = payload?.nodes.filter((n) => n.kind === 'procedure').length ?? 0
  const isEmpty = payload != null && payload.nodes.length === 0 && !loading

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <MemoryGraphCanvas />

      {/* ── Top chrome: search + commands share ONE wrapping row, honesty pills
           sit beneath them. A single flow container rather than three separate
           absolutes, which used to overlap each other (and the inspector) as
           the canvas narrowed, leaving the search box unclickable. ── */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          // Reserve the inspector rail so the controls stay reachable while a
          // node is selected.
          right: selectedNodeId ? INSPECT_RAIL + 24 : 12,
          zIndex: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {/* ── Search ── */}
          <div
            className="surface-floating-tier"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: 4,
              borderRadius: 12,
            }}
          >
            <div style={{ width: 220 }}>
              <SearchInput
                value={query}
                onChange={onQueryChange}
                onKeyDown={onSearchKeyDown}
                placeholder="Search memory…"
                size="sm"
                aria-label="Search memory graph"
                data-testid="memory-graph-search"
              />
            </div>
            {/* Mode segment hidden when no provider — degrade honestly to FTS. */}
            {provider != null && (
              <SegmentedControl<SearchMode>
                options={MODES.map((m) => ({ id: m, label: m }))}
                value={mode}
                onChange={setMode}
                size="sm"
                aria-label="Search mode"
              />
            )}
          </div>

          {/* ── Commands ── */}
          <div
            role="toolbar"
            aria-label="Memory graph controls"
            className="surface-floating-tier"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              padding: 4,
              borderRadius: 12,
            }}
          >
            <BarBtn
              icon={RefreshCw}
              label="Re-layout (refresh)"
              onClick={() => useMemoryGraphStore.getState().bumpRefresh()}
            />
            <BarDivider />
            <BarBtn
              icon={Pin}
              label="Community hulls"
              tint="mint"
              active={showHulls}
              onClick={() => useMemoryGraphStore.getState().setShowHulls(!showHulls)}
            />
            <BarDivider />
            <SegmentedControl<MemScopeFilter>
              options={SCOPE_OPTIONS}
              value={scopeFilter}
              onChange={(v) => useMemoryGraphStore.getState().setScopeFilter(v)}
              size="sm"
              aria-label="Scope filter"
            />
            <SegmentedControl<MemTimeFilter>
              options={TIME_OPTIONS}
              value={timeFilter}
              onChange={(v) => useMemoryGraphStore.getState().setTimeFilter(v)}
              size="sm"
              aria-label="Time filter"
            />
          </div>
        </div>

        {/* ── Honesty pills: no silent caps, no fake similarity ── */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 6,
            pointerEvents: 'none',
          }}
        >
          {/* Truncation is per-kind — the OR'd payload.truncated flag would mislabel
            a procedure-only cap as "facts". */}
          {payload != null && payload.totalFacts > factNodeCount && (
            <StatusPill
              tone="warning"
              label={`Showing newest ${factNodeCount} of ${payload.totalFacts} facts`}
            />
          )}
          {payload != null && payload.totalProcedures > procNodeCount && (
            <StatusPill
              tone="warning"
              label={`Showing newest ${procNodeCount} of ${payload.totalProcedures} procedures`}
            />
          )}
          {noMatch && <StatusPill tone="idle" label="No matches" />}
          {/* Surface the computed honesty field (not just provider == null), so a
            provider-present-but-no-comparable-embeddings store degrades honestly. */}
          {payload != null && payload.nodes.length > 0 && !payload.similarityAvailable && (
            <StatusPill
              tone="idle"
              label={
                provider == null
                  ? 'Similarity links unavailable: no embedding provider'
                  : 'Similarity links unavailable: no comparable embeddings yet'
              }
            />
          )}
        </div>
      </div>

      {/* ── Bottom-right viewport bar ── */}
      <div
        role="toolbar"
        aria-label="Viewport"
        className="surface-floating-tier"
        style={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: 4,
          borderRadius: 12,
        }}
      >
        <BarBtn icon={ZoomOut} label="Zoom out" onClick={() => void zoomOut({ duration: 200 })} />
        <BarBtn icon={ZoomIn} label="Zoom in" onClick={() => void zoomIn({ duration: 200 })} />
        <BarBtn
          icon={Maximize2}
          label="Fit to view"
          onClick={() => void fitView({ padding: 0.2, duration: 300 })}
        />
        <BarDivider />
        <BarBtn
          icon={locked ? Lock : LockOpen}
          label={locked ? 'Unlock canvas (enable dragging)' : 'Lock canvas (freeze positions)'}
          tint="mint"
          active={locked}
          onClick={() => useMemoryGraphStore.getState().setLocked(!locked)}
        />
        <BarBtn
          icon={showMinimap ? X : MapIcon}
          label={showMinimap ? 'Hide minimap' : 'Show minimap'}
          tint="mint"
          active={showMinimap}
          onClick={() => useMemoryGraphStore.getState().setShowMinimap(!showMinimap)}
        />
      </div>

      <LegendPanel />
      <InspectPanel />

      {/* ── Error banner + Retry (fetch failed — distinct from empty store) ── */}
      {error && !payload && (
        <div
          data-testid="memory-graph-error"
          style={{
            position: 'absolute',
            top: 64,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 30,
            width: 'min(420px, 90%)',
          }}
        >
          <FormattedAlert tone="error">
            <span className="flex items-center gap-2">
              {error}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => useMemoryGraphStore.getState().bumpRefresh()}
              >
                Retry
              </Button>
            </span>
          </FormattedAlert>
        </div>
      )}

      {/* ── Teaching empty state ── */}
      {isEmpty && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 15,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <EmptyState
            icon={Brain}
            title="Nothing remembered yet"
            helper="Agents save facts with memory_save; they're recalled into every relevant run. Anything saved here is shared team knowledge."
            action={
              onOpenList ? (
                <Button variant="primary" size="md" onClick={onOpenList}>
                  Save your first fact
                </Button>
              ) : undefined
            }
          />
        </div>
      )}
    </div>
  )
}

/** Inspector rail width (InspectPanel), reserved by the top chrome so its
 *  controls stay reachable while a node is selected. */
const INSPECT_RAIL = 320

export function MemoryGraphView({ onOpenList }: { onOpenList?: () => void }) {
  return (
    <ReactFlowProvider>
      <MemoryGraphViewInner onOpenList={onOpenList} />
    </ReactFlowProvider>
  )
}
