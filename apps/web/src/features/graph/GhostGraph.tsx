import { readAgentFile, writeAgentFile } from '@clawboo/control-client'
import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react'
import type {
  NodeMouseHandler,
  EdgeMouseHandler,
  OnNodeDrag,
  Node,
  Connection,
  IsValidConnection,
  MiniMapNodeProps,
} from '@xyflow/react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  GitBranch,
  LayoutDashboard,
  Lock,
  LockOpen,
  Map,
  Maximize2,
  Pin,
  RefreshCw,
  Sparkles,
  Terminal,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button, IconButton } from '@/features/shared/Button'
import { useGraphStore } from './store'
import { useGraphData } from './useGraphData'
import { useGraphPersistence } from './useGraphPersistence'
import { computeElkLayout, computeAtlasLayout, computeAtlasRadialLayout } from './useGraphLayout'
import { useTeamStore } from '@/stores/team'
import { useObsGraphOverlay } from '@/features/obs'
import { useObsOverlayStore } from '@/stores/obsOverlay'
import { computeOrbitalPositions } from './computeOrbitalPositions'
import { nodeTypes } from './nodes/nodeTypes'
import { edgeTypes } from './edges/edgeTypes'
import { ConnectionLine } from './edges/ConnectionLine'
import { TeamHaloLayer } from './TeamHaloLayer'
import { TeamStatusClusterLayer } from './TeamStatusClusterLayer'
import { useFleetStore } from '@/stores/fleet'
import { useViewStore } from '@/stores/view'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { mutationQueue } from '@/lib/mutationQueue'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { GraphContextMenu } from './GraphContextMenu'
import { installSkillForAgent } from './operations/installSkill'
import { removeRouting } from './operations/removeRouting'
import { graphPhysics } from './graphPhysics'
import { EdgeMarkers } from './edges/EdgeMarkers'
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import type { BooNodeData, SkillNodeData, GraphEdge, LayoutData, GhostGraphScope } from './types'

interface ContextMenuState {
  x: number
  y: number
  agentId: string
  agentName: string
}

// fitView() honours the bounding box of every node we pass in. By default it
// fits the full graph — but our peacock-collapse model keeps skill / resource
// nodes mounted at their orbital positions (150–220 px from each Boo) with
// `opacity: 0; scale: 0`. fitView still sees them, so it zooms out far enough
// for the invisible ring, and the actual visible Boos render at ~30 % of
// their nominal size. We filter to the nodes the user can actually see —
// every Boo (always rendered) plus any orbital child whose parent is
// currently expanded — so the camera frames only what's on screen.
//
// We can't read `node.data.isVisible` directly because the raw store nodes
// don't carry it; the flag is added downstream in the `visibleNodes` memo.
// Instead we re-derive visibility from `expandedBooNodeIds` (the actual
// source of truth — same path the memo uses).
function pickFittableNodes(nodes: Node[], expandedBooIds: Set<string>): { id: string }[] {
  return nodes
    .filter((n) => {
      if (n.type === 'boo') return true
      // Atlas team-root junctions are 1px invisible — exclude from fit
      // so the camera frames the visible Boos, not the routing points.
      if (n.type === 'team-root') return false
      if (n.type !== 'skill' && n.type !== 'resource') return true
      const agentIds = (n.data as { agentIds?: string[] } | undefined)?.agentIds
      const ownerAgentId = agentIds?.[0]
      if (!ownerAgentId) return false
      return expandedBooIds.has(`boo-${ownerAgentId}`)
    })
    .map((n) => ({ id: n.id }))
}

// Custom MiniMap node renderer.
//
// React Flow's default MiniMap draws each node at its actual rendered size.
// Our BooNode is a 340×340 transparent footprint with the visible Boo
// (~80px circle / 220×120 card) centered inside it — see BOO_FOOTPRINT in
// nodes/BooNode.tsx. Rendering the full footprint in the MiniMap makes Boos
// look enormously out of proportion vs. the actual visible shape on the
// canvas. This component draws Boos as a smaller centered dot so the MiniMap
// reflects what the user actually sees. Skill / resource nodes already
// render at sensible visual sizes, so they're drawn at their measured size.
function GhostGraphMiniMapNode({
  id,
  x,
  y,
  width,
  height,
  color,
  borderRadius,
  className,
  shapeRendering,
  strokeColor,
  strokeWidth,
  selected,
}: MiniMapNodeProps) {
  const fill = color ?? 'rgb(var(--foreground-rgb) / 0.5)'
  if (color === 'transparent') return null
  // Atlas team-root junctions are invisible 1px routing points; the
  // MiniMap should also hide them so it reflects what the user sees.
  if (id.startsWith('team-root-')) return null
  const stroke = strokeColor ?? 'transparent'
  const sw = strokeWidth ?? 0
  if (id.startsWith('boo-')) {
    // Visible Boo is roughly 80–120 px on canvas; pick 110 as a single
    // representative size that reads well in MiniMap regardless of whether
    // the source Boo is in idle-circle or active-card mode.
    const visualSize = 110
    return (
      <circle
        cx={x + width / 2}
        cy={y + height / 2}
        r={visualSize / 2}
        fill={fill}
        stroke={stroke}
        strokeWidth={sw}
        shapeRendering={shapeRendering}
        className={className + (selected ? ' selected' : '')}
      />
    )
  }
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      rx={borderRadius}
      ry={borderRadius}
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      shapeRendering={shapeRendering}
      className={className + (selected ? ' selected' : '')}
    />
  )
}

// ─── Canvas control primitives ──────────────────────────────────────────────
//
// One shared visual dialect for every piece of graph chrome. The top command
// bar AND the bottom viewport bar are both built from these atoms inside a
// single `.surface-floating-tier` glass shell — so the controls read as ONE
// coordinated system instead of the old three-corner / three-language sprawl.
// Buttons carry NO per-button border/background; the glass shell is the single
// elevated plane and hover is a quiet fill-fade (no jittery per-button lift).
//
// Accent semantics (two tiers, matching the product convention):
//   • primary (red)   — the single forward authoring action (Connect).
//   • mint            — an on/overlay toggle is engaged (Halos, Activity, Lock,
//                       Minimap-shown).
//   • neutral         — a momentary action's transient pressed tint.

type BarTint = 'primary' | 'mint' | 'neutral'

function BarBtn({
  icon: Icon,
  label,
  onClick,
  active,
  tint = 'primary',
  disabled,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  active?: boolean
  tint?: BarTint
  disabled?: boolean
}) {
  const activeClass =
    tint === 'mint'
      ? 'bg-mint/[0.18] text-mint'
      : tint === 'neutral'
        ? 'bg-foreground/[0.10] text-foreground'
        : 'bg-primary/[0.18] text-primary'
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active ?? undefined}
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1',
        'disabled:cursor-default disabled:opacity-40',
        active
          ? activeClass
          : 'text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90',
      ].join(' ')}
    >
      <Icon size={15} strokeWidth={2} aria-hidden />
    </button>
  )
}

function BarDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-[rgb(var(--foreground-rgb)/0.1)]" />
}

// The one labeled inline segment in the whole control system — the Atlas
// layout MODE pick (a choice where one is always selected), so it earns the
// recessed-track + raised-chip treatment (the ThemeToggle pattern) to read
// unmistakably as a switch, distinct from the icon-only toggles beside it.
function LayoutModeSegment({
  value,
  onChange,
}: {
  value: 'top-down' | 'radial'
  onChange: (v: 'top-down' | 'radial') => void
}) {
  const opts = [
    {
      id: 'top-down' as const,
      label: 'Tree',
      icon: LayoutDashboard,
      title: 'Flat-row tree — Boo Zero at top, teams in a row',
    },
    {
      id: 'radial' as const,
      label: 'Radial',
      icon: Sparkles,
      title: 'Radial — Boo Zero at centre, teams as petals',
    },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Atlas layout"
      className="flex items-center gap-0.5 rounded-md bg-[rgb(var(--foreground-rgb)/0.05)] p-0.5"
    >
      {opts.map((o) => {
        const active = value === o.id
        const Icon = o.icon
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={[
              'flex h-7 cursor-pointer items-center gap-1 rounded-[5px] px-2 text-[11.5px] font-semibold transition-all duration-150',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1',
              active
                ? 'bg-surface text-foreground shadow-[var(--shadow-raised)]'
                : 'text-foreground/50 hover:text-foreground/80',
            ].join(' ')}
          >
            <Icon size={12.5} strokeWidth={2} aria-hidden />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── GhostGraph ───────────────────────────────────────────────────────────────
//
// Must be rendered inside <ReactFlowProvider> (done by GhostGraphPanel).
//
// `scope` controls global-vs-team data behavior + halos UX (see
// `GhostGraphPanel` for the full contract). Defaults to `'team'`.

export function GhostGraph({ scope = 'team' }: { scope?: GhostGraphScope } = {}) {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    savedPositions,
    layoutKey,
    selectedEdgeId,
    setSelectedEdgeId,
    setNodes,
    hasRunLayout,
    setHasRunLayout,
    resetLayout,
    updateNodePosition,
    connectMode,
    setConnectMode,
    showTeamHalos,
    setShowTeamHalos,
    atlasLayout,
    setAtlasLayout,
    setHoveredNodeId,
  } = useGraphStore()

  // Subscribed separately so the visibility memo only re-runs when the Set
  // identity changes — not on every nodes/edges update from physics ticks.
  const expandedBooNodeIds = useGraphStore((s) => s.expandedBooNodeIds)

  // Event-sourced live overlay: source per-agent status/cost from the projected event log so the
  // team graph's LIVE layer can't drift from reality. Pushed to a tiny store that
  // BooNode reads by id — NOT via setNodes, so the ELK/physics pipeline is
  // untouched and the live overlay never perturbs the layout.
  const obsTeamId = useTeamStore((s) => s.selectedTeamId)
  const obsOverlay = useObsGraphOverlay(scope === 'team' ? obsTeamId : null)
  useEffect(() => {
    useObsOverlayStore.getState().setOverlay(obsOverlay.status, obsOverlay.cost)
  }, [obsOverlay])

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  // Hide the MiniMap (bottom-right overview) by default to give Boos more
  // visible canvas. A small floating toggle button takes its place; clicking
  // it expands the MiniMap back when the user wants to navigate a large graph.
  const [showMiniMap, setShowMiniMap] = useState(false)

  // Atlas-only: a slide-in global activity dock — the live "what is every team
  // doing" terminal. Always mounted (so the slide animates both ways); the obs
  // subscription is gated on `showActivityDock` so it only tails when open.
  const [showActivityDock, setShowActivityDock] = useState(false)

  // Canvas interactivity lock (viewport bar). When locked, node dragging +
  // selection are frozen (pan/zoom stay free) so the graph can be inspected
  // without accidental drags — the design-system replacement for React Flow's
  // default <Controls> interactivity toggle.
  const [locked, setLocked] = useState(false)

  const nodesInitialized = useNodesInitialized()
  const { fitView, zoomIn, zoomOut } = useReactFlow()

  // Track the canvas wrapper size so we can (a) re-fit the graph when the
  // panel is resized (e.g. user drags the divider in the new vertical group
  // chat layout) and (b) size the MiniMap proportionally to the canvas.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 })

  // Track layout state in refs to avoid stale closure issues
  const layoutRanRef = useRef(false)
  const prevNodeLengthRef = useRef(0)
  const elkGenerationRef = useRef(0)
  const prevLayoutKeyRef = useRef(layoutKey)
  // Flipping atlasLayout requires a fresh layout dispatch even
  // when node count + layoutKey haven't changed. Tracked separately so a
  // toggle invalidates `layoutRanRef` exactly once per change.
  const prevAtlasLayoutRef = useRef(atlasLayout)

  // Wire data fetching and persistence. The scope drives whether
  // `useGraphData` filters to `selectedTeamId` or shows every team at once,
  // AND it scopes the persistence key so Atlas and the team-scoped Ghost
  // Graph don't overwrite each other's saved positions (Atlas's positions
  // are global; the team chat's positions are per-team).
  useGraphData(scope)
  const { savePositions, isLoaded } = useGraphPersistence(scope)

  // Wire physics wake callback — when a boo node is dragged, wake the physics engine
  useEffect(() => {
    useGraphStore.getState().setPhysicsWakeCallback(() => graphPhysics.wake())
    return () => {
      useGraphStore.getState().setPhysicsWakeCallback(null)
      graphPhysics.dispose()
    }
  }, [])

  // Observe the canvas wrapper so we can refit + resize the MiniMap when the
  // surrounding panel changes shape (group chat divider drag, window resize,
  // navigating into / out of group chat with its short-and-wide row layout).
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setContainerSize((prev) =>
            Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5
              ? prev
              : { w: width, h: height },
          )
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Refit the view when the container size changes (debounced). Only fires
  // after the initial layout has run, otherwise the layout effect already
  // calls fitView once Boos land. Skipped on the very first dimensions read
  // (matches the initial 800×600 default → no spurious refit on mount).
  const refitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialFitDoneRef = useRef(false)
  useEffect(() => {
    if (!hasRunLayout) return
    if (!initialFitDoneRef.current) {
      initialFitDoneRef.current = true
      return
    }
    if (refitTimerRef.current) clearTimeout(refitTimerRef.current)
    refitTimerRef.current = setTimeout(() => {
      const state = useGraphStore.getState()
      void fitView({
        padding: 0.04,
        duration: 250,
        maxZoom: 1.5,
        nodes: pickFittableNodes(state.nodes, state.expandedBooNodeIds),
      })
    }, 180)
    return () => {
      if (refitTimerRef.current) clearTimeout(refitTimerRef.current)
    }
  }, [containerSize.w, containerSize.h, hasRunLayout, fitView])

  // MiniMap stays small relative to the canvas — ~16% wide, ~22% tall, with
  // sensible min/max so it neither becomes invisible on tiny panels nor
  // dominates the canvas on large ones.
  const minimapDims = useMemo(() => {
    const w = Math.round(Math.max(110, Math.min(180, containerSize.w * 0.16)))
    const h = Math.round(Math.max(72, Math.min(130, containerSize.h * 0.22)))
    return { w, h }
  }, [containerSize.w, containerSize.h])

  // ── Two-layer auto-layout ────────────────────────────────────────────────────
  // Layer 1: ELK positions boo nodes using dependency edges only (async).
  // Layer 2: Orbital positions skill/resource nodes around their parent boo (sync).
  // Re-runs when node count changes or user clicks "Re-layout" (layoutKey bump).
  //
  // Persistence: previously, ELK results were only applied to the local store
  // (via setNodes) and NEVER saved to /api/graph-layout. The only save path was
  // drag-end. Effect: clicking "Re-layout" sorted the visible canvas but on
  // refresh the stale saved positions reloaded, undoing the sort. Fix: after
  // every ELK computation, save the resulting positions so refresh is a no-op.
  //
  // Staleness: ELK preserves saved positions per node id, so when Boo Zero is
  // synthesized into a team's graph for the first time (new node id), the
  // other Boos still snap to their old saved positions while Boo Zero lays
  // out fresh — looks broken. We detect this case (some boo nodes have saved
  // positions, but the synthesized Boo Zero does not) and clear ALL saved
  // boo positions for this layout, forcing a full re-layout. User-saved drag
  // positions get re-established on the next deliberate drag.
  useEffect(() => {
    // Reset when layoutKey bumps (user pressed "Re-layout"). We also CLEAR
    // saved positions here so the re-layout produces a fresh ELK result
    // (not constrained by the old user-dragged positions).
    const reLayoutTriggered = layoutKey !== prevLayoutKeyRef.current
    if (reLayoutTriggered) {
      prevLayoutKeyRef.current = layoutKey
      layoutRanRef.current = false
      prevNodeLengthRef.current = 0
    }

    // atlasLayout flip is a re-layout trigger of the same kind as
    // pressing "Re-layout". CRITICAL: it must also DROP saved positions, not
    // just invalidate `layoutRanRef`. Without dropping, the new layout
    // function (e.g. Tree's `computeAtlasLayout`) reuses saved coordinates
    // that were computed for the OTHER mode (Radial), producing the visually
    // broken result where teams scatter at radial spots inside a tree layout.
    const atlasLayoutFlipped = atlasLayout !== prevAtlasLayoutRef.current
    if (atlasLayoutFlipped) {
      prevAtlasLayoutRef.current = atlasLayout
      layoutRanRef.current = false
      prevNodeLengthRef.current = 0
    }

    // Either trigger forces a fresh layout AND drops saved positions for any
    // node whose mode is changing. This is the variable consulted by
    // `effectiveSavedPositions` below.
    const reLayoutRequested = reLayoutTriggered || atlasLayoutFlipped

    if (!nodesInitialized || nodes.length === 0 || !isLoaded) return

    // Reset when node count changes (new agents added)
    if (nodes.length !== prevNodeLengthRef.current) {
      prevNodeLengthRef.current = nodes.length
      layoutRanRef.current = false
    }

    if (layoutRanRef.current) return
    layoutRanRef.current = true

    // Increment generation only when actually starting ELK computation.
    const generation = ++elkGenerationRef.current

    // Layer 1: Boo nodes + team-root junctions + PRIMARY dependency edges
    // go through ELK. Secondary edges (every routing rule outside the
    // spanning tree from the team leader) are intentionally withheld —
    // feeding them to ELK would re-introduce the edge-tangle that
    // obscured the leader → teammate flow. Secondary edges are still
    // rendered, but only on hover, and they don't influence layout.
    // Team-root nodes are 1px invisible routing points used in Atlas to
    // form the BZ → junction → team-members hierarchy — they participate
    // in ELK's layered placement but are not orbital parents (skills /
    // resources orbit Boos only).
    const booNodes = nodes.filter((n) => n.type === 'boo')
    const layoutBooNodes = nodes.filter((n) => n.type === 'boo' || n.type === 'team-root')
    const nonBooNodes = nodes.filter((n) => n.type !== 'boo' && n.type !== 'team-root')
    const primaryDepEdges = edges.filter(
      (e) => e.type === 'dependency' && (e.data as { isPrimary?: boolean })?.isPrimary !== false,
    )

    // Detect cases where saved positions can't be trusted:
    //   (a) Partial coverage — some boos have saved positions, others don't.
    //       Typically happens when Boo Zero is newly synthesized into a team
    //       and the older non-Boo-Zero positions are still in SQLite.
    //   (b) Runaway span — a previous version of `stretchToAspect` (now
    //       fixed) stretched both axes and compounded across re-layouts,
    //       producing layouts spanning thousands of ELK units. We detect
    //       these by checking the bbox of saved boo positions; if either
    //       dimension exceeds 4000 px the positions are stale-blown-up and
    //       should be discarded.
    const savedBooPositions = booNodes
      .map((n) => savedPositions[n.id])
      .filter((p): p is { x: number; y: number } => Boolean(p))
    const savedBooIds = booNodes.filter((n) => savedPositions[n.id]).map((n) => n.id)
    const partialSavedCoverage = savedBooIds.length > 0 && savedBooIds.length < booNodes.length

    let runawaySpan = false
    if (savedBooPositions.length >= 2) {
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity
      for (const p of savedBooPositions) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      const SPAN_LIMIT = 4000
      if (maxX - minX > SPAN_LIMIT || maxY - minY > SPAN_LIMIT) {
        runawaySpan = true
      }
    }

    const effectiveSavedPositions =
      reLayoutRequested || partialSavedCoverage || runawaySpan ? {} : savedPositions

    // Pass the canvas aspect so ELK's hierarchy-driven output can be stretched
    // to claim the empty bands fitView would otherwise leave (see
    // stretchToAspect in useGraphLayout.ts).
    const canvasAspect =
      containerSize.w > 0 && containerSize.h > 0 ? containerSize.w / containerSize.h : undefined

    // **Team scope**: single-pass ELK over Boo nodes + primary edges.
    // **Atlas scope**: per-team ELK + horizontal packing. Each team
    // gets its own self-contained ELK pass, then the clusters are
    // packed horizontally with team-root junctions and Boo Zero
    // positioned manually above them. This decouples each team's
    // internal hierarchy depth from every other team's, so all teams
    // sit at the same visual level under Boo Zero regardless of how
    // deep their internal AGENTS.md routing goes — exactly the shape
    // in the user's hand-drawn sketch.
    const teamOrder = useTeamStore.getState().teams.map((t) => t.id)
    const layoutPromise =
      scope === 'atlas'
        ? atlasLayout === 'radial'
          ? computeAtlasRadialLayout(
              layoutBooNodes,
              primaryDepEdges,
              effectiveSavedPositions,
              teamOrder,
            )
          : computeAtlasLayout(layoutBooNodes, primaryDepEdges, effectiveSavedPositions, teamOrder)
        : computeElkLayout(layoutBooNodes, primaryDepEdges, effectiveSavedPositions, canvasAspect)

    void layoutPromise.then((layoutedNodes) => {
      // Skip stale results — a newer ELK computation has started
      if (generation !== elkGenerationRef.current) return

      // Split ELK-positioned nodes back into Boos and team-roots so that
      // computeOrbitalPositions only sees Boos (orbital parents). The
      // team-roots are passed through to setNodes unchanged at their
      // ELK-assigned positions.
      const layoutedBooNodes = layoutedNodes.filter((n) => n.type === 'boo')
      const layoutedTeamRoots = layoutedNodes.filter((n) => n.type === 'team-root')

      // Layer 2: Position skills/resources in orbital arcs around their parent boo
      const orbitalNodes = computeOrbitalPositions(
        layoutedBooNodes,
        nonBooNodes,
        edges, // full edges needed for parent-child mapping
        effectiveSavedPositions,
      )

      setNodes([...layoutedBooNodes, ...layoutedTeamRoots, ...orbitalNodes])
      setHasRunLayout(true)

      // Persist the resulting positions so refresh is a no-op.
      // This runs on EVERY successful ELK pass (initial layout, node-count
      // change, re-layout button) — the debounce inside `savePositions`
      // collapses rapid successive saves.
      const nextPositions: LayoutData['positions'] = { ...savedPositions }
      for (const n of layoutedBooNodes) nextPositions[n.id] = n.position
      for (const n of layoutedTeamRoots) nextPositions[n.id] = n.position
      for (const n of orbitalNodes) nextPositions[n.id] = n.position
      // If we cleared the saved set (re-layout or partial coverage), drop
      // any stale entries that aren't in the current node list — they're
      // for nodes that no longer exist.
      if (reLayoutRequested || partialSavedCoverage) {
        const currentIds = new Set([
          ...layoutedBooNodes.map((n) => n.id),
          ...layoutedTeamRoots.map((n) => n.id),
          ...orbitalNodes.map((n) => n.id),
        ])
        for (const id of Object.keys(nextPositions)) {
          if (!currentIds.has(id)) delete nextPositions[id]
        }
      }
      savePositions(nextPositions)

      // Initialize physics particles from layouted positions
      requestAnimationFrame(() => {
        const current = useGraphStore.getState()
        graphPhysics.initialize(current.nodes, current.edges)
      })

      requestAnimationFrame(() => {
        // Tight padding gives Boos visual prominence; maxZoom caps the fit so
        // tiny graphs (1–2 Boos) don't blow up to fill the canvas.
        // `nodes` filter excludes the invisible-by-default orbital children —
        // see pickFittableNodes() above for why this matters.
        const state = useGraphStore.getState()
        void fitView({
          padding: 0.04,
          duration: 500,
          maxZoom: 1.5,
          nodes: pickFittableNodes(state.nodes, state.expandedBooNodeIds),
        })
      })
    })
    // isLoaded gates layout until saved positions are fetched from SQLite.
    // `scope` is in deps so the effect re-runs when Atlas ↔ team chat
    // transitions swap which layout fn is needed. Scope-change remounts
    // (via the `ReactFlowProvider` key in `GhostGraphPanel`) would also
    // pick up the new scope through the closure on the fresh mount —
    // keeping `scope` here is the defensive belt to that suspenders.
  }, [nodesInitialized, nodes.length, layoutKey, isLoaded, scope, atlasLayout])

  // ── Interaction handlers ─────────────────────────────────────────────────────

  const onNodeDragStart: OnNodeDrag<Node> = useCallback((_event, node) => {
    if (node.type === 'skill' || node.type === 'resource' || node.type === 'boo') {
      graphPhysics.pinNode(node.id)
    }
  }, [])

  const onNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, node) => {
      updateNodePosition(node.id, node.position)
      const currentSaved = useGraphStore.getState().savedPositions
      savePositions({ ...currentSaved, [node.id]: node.position })

      if (node.type === 'skill' || node.type === 'resource' || node.type === 'boo') {
        graphPhysics.unpinNode(node.id)
      }
    },
    [updateNodePosition, savePositions],
  )

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_event, edge) => {
      setSelectedEdgeId(selectedEdgeId === edge.id ? null : edge.id)
    },
    [selectedEdgeId, setSelectedEdgeId],
  )

  // Single-click on a Boo toggles its orbital children (skills + resources)
  // visibility — peacock-feather expand / collapse. The previous left-click
  // behaviour of "select agent in the sidebar" is now available from the
  // right-click context menu (`Select in sidebar` item) and is also implicit
  // when the user picks Chat / Edit personality / Edit files there.
  const onNodeClick: NodeMouseHandler<Node> = useCallback((_event, node) => {
    if (node.type === 'boo') {
      useGraphStore.getState().toggleBooNodeExpanded(node.id)
    }
  }, [])

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    if (node.type !== 'boo') return
    const data = node.data as BooNodeData
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      agentId: data.agentId,
      agentName: data.name,
    })
  }, [])

  // ── Hover cascade handlers ────────────────────────────────────────────────
  const onNodeMouseEnter: NodeMouseHandler<Node> = useCallback(
    (_event, node) => {
      setHoveredNodeId(node.id)
    },
    [setHoveredNodeId],
  )

  const onNodeMouseLeave: NodeMouseHandler<Node> = useCallback(() => {
    setHoveredNodeId(null)
  }, [setHoveredNodeId])

  const onConnect = useCallback(
    async (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source)
      const targetNode = nodes.find((n) => n.id === connection.target)
      if (!sourceNode || !targetNode) return

      // Skill-to-Boo: drag a SkillNode onto a BooNode to install
      if (sourceNode.type === 'skill' && targetNode.type === 'boo') {
        const skillData = sourceNode.data as SkillNodeData
        const booData = targetNode.data as BooNodeData
        void installSkillForAgent(skillData.name, booData.agentId, booData.name)
        return
      }

      if (sourceNode.type !== 'boo' || targetNode.type !== 'boo') return

      const sourceAgentId = sourceNode.data.agentId as string
      const sourceAgentName = sourceNode.data.name as string
      const targetAgentName = targetNode.data.name as string

      const client = useConnectionStore.getState().client
      if (!client) return

      // Check for existing edge before adding
      const existingEdge = useGraphStore
        .getState()
        .edges.find(
          (e) =>
            e.source === connection.source &&
            e.target === connection.target &&
            e.type === 'dependency',
        )
      if (existingEdge) {
        useToastStore.getState().addToast({
          message: `${targetAgentName} already in routing`,
          type: 'info',
        })
        return
      }

      // Optimistically add edge to graph immediately
      const targetAgentId = (targetNode.data as BooNodeData).agentId
      const optimisticEdge: GraphEdge = {
        id: `dep-${sourceAgentId}-${targetAgentId}`,
        type: 'dependency',
        source: connection.source,
        sourceHandle: 'center',
        target: connection.target,
        targetHandle: 'center-target',
        data: {},
      }
      const store = useGraphStore.getState()
      store.setEdges([...store.edges, optimisticEdge])

      try {
        const currentAgentsMd = await readAgentFile(sourceAgentId, 'AGENTS.md').catch(
          () => '# AGENTS\n',
        )

        if (currentAgentsMd.includes('@' + targetAgentName)) {
          // Already in file, edge is correct — just notify
          useToastStore.getState().addToast({
            message: `${targetAgentName} already in routing`,
            type: 'info',
          })
          return
        }

        const newAgentsMd =
          currentAgentsMd.trimEnd() + '\n- Route to @' + targetAgentName + ' for delegated tasks.\n'
        await mutationQueue.enqueue(sourceAgentId, () =>
          writeAgentFile(sourceAgentId, 'AGENTS.md', newAgentsMd),
        )

        // Update local agentFiles cache so the structural rebuild in useGraphData
        // naturally includes this edge. Do NOT call triggerRefresh() here — that
        // triggers a full async re-fetch which overwrites edges (including our
        // optimistic one) before the Gateway has time to persist.
        useGraphStore.getState().setAgentFiles(sourceAgentId, { agentsMd: newAgentsMd })

        useToastStore.getState().addToast({
          message: `Routing added: ${sourceAgentName} \u2192 ${targetAgentName}`,
          type: 'success',
        })

        // Ensure agent-to-agent coordination is enabled in Gateway config (idempotent)
        fetch('/api/system/openclaw-config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentToAgent: { enabled: true } }),
        }).catch(() => {
          // non-fatal — user can enable manually in System panel
        })
      } catch (_err) {
        // Rollback optimistic edge on failure
        const current = useGraphStore.getState()
        current.setEdges(current.edges.filter((e) => e.id !== optimisticEdge.id))
        useToastStore.getState().addToast({
          message: 'Failed to save routing',
          type: 'error',
        })
      }
    },
    [nodes],
  )

  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const source = nodes.find((n) => n.id === connection.source)
      const target = nodes.find((n) => n.id === connection.target)
      if (source?.type === 'skill' && target?.type === 'boo') return true
      return source?.type === 'boo' && target?.type === 'boo' && source.id !== target.id
    },
    [nodes],
  )

  const onPaneClick = useCallback(() => {
    setSelectedEdgeId(null)
    setContextMenu(null)
    setHoveredNodeId(null)
  }, [setSelectedEdgeId, setHoveredNodeId])

  const handleDeleteEdge = useCallback(
    async (edgeId: string) => {
      const edge = edges.find((e) => e.id === edgeId)
      if (!edge || edge.type !== 'dependency') return

      const sourceAgentId = edge.source.startsWith('boo-') ? edge.source.slice(4) : null
      const targetAgentId = edge.target.startsWith('boo-') ? edge.target.slice(4) : null
      if (!sourceAgentId || !targetAgentId) return

      setSelectedEdgeId(null)
      await removeRouting(edgeId, sourceAgentId, targetAgentId)
    },
    [edges, setSelectedEdgeId],
  )

  // ── Derive selected edge for explain panel ───────────────────────────────────
  const selectedEdge = selectedEdgeId ? (edges.find((e) => e.id === selectedEdgeId) ?? null) : null

  // ── Derive visibility for skill/resource nodes + their edges ──────────────
  // Boos and dependency edges are always visible. Skill / resource nodes are
  // hidden by default and revealed only when the user clicks (and thus
  // expands) their parent Boo.
  //
  // Two different visibility mechanisms:
  //   • EDGES use React Flow's native `hidden: true` — fastest path, no
  //     animation needed (the edge just disappears when its parent Boo
  //     collapses).
  //   • NODES use a `data.isVisible` flag we read inside SkillNode /
  //     ResourceNode. We DON'T use React Flow's `hidden: true` for nodes
  //     because that maps to `display: none`, which is non-animatable —
  //     and we want the peacock-feather expand / collapse transition.
  //     Hidden nodes stay mounted with `opacity: 0` + `scale: 0`, animated
  //     by Framer Motion in the node component.
  //
  // Parent Boo IDs are derived from the existing source-of-truth (the
  // node's `agentIds[0]` for skill/resource nodes; the edge's `source` for
  // skill/resource edges) — no `buildGraphElements` change needed.
  const visibleNodes = useMemo<typeof nodes>(() => {
    if (nodes.length === 0) return nodes
    return nodes.map((n) => {
      if (n.type === 'boo') {
        return (n.hidden ? { ...n, hidden: false } : n) as typeof n
      }
      if (n.type !== 'skill' && n.type !== 'resource') return n
      const ownerAgentId = n.data.agentIds?.[0]
      const parentBooId = ownerAgentId ? `boo-${ownerAgentId}` : null
      const isVisible = !!parentBooId && expandedBooNodeIds.has(parentBooId)
      if (n.data.isVisible === isVisible) return n
      // Always keep skill/resource nodes mounted (`hidden` never set);
      // visibility is animated inside the node component via `data.isVisible`.
      // The cast keeps the discriminated union narrow per branch.
      return { ...n, data: { ...n.data, isVisible } } as typeof n
    })
  }, [nodes, expandedBooNodeIds])

  const visibleEdges = useMemo(() => {
    if (edges.length === 0) return edges
    return edges.map((e) => {
      if (e.type === 'dependency') {
        return e.hidden ? { ...e, hidden: false } : e
      }
      if (e.type !== 'skill' && e.type !== 'resource') return e
      // Skill / resource edges always have the parent Boo as `source`.
      const shouldBeHidden = !expandedBooNodeIds.has(e.source)
      if (e.hidden === shouldBeHidden) return e
      return { ...e, hidden: shouldBeHidden }
    })
  }, [edges, expandedBooNodeIds])

  return (
    <div
      ref={wrapperRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        // Background moved here from <ReactFlow> so TeamHaloLayer can render
        // between the wrapper bg and ReactFlow's transparent canvas.
        background: 'var(--canvas)',
        // Hide nodes until ELK has positioned them — prevents (0,0) pile-up flash on new teams
        opacity: hasRunLayout ? 1 : 0,
        transition: 'opacity 0.25s ease',
      }}
    >
      {/* SVG marker definitions referenced by edges (e.g.
          DependencyEdge's `markerEnd="url(#dependency-arrow)"`).
          Mounted once — marker IDs are global to the document. */}
      <EdgeMarkers />

      {/* Team halos layer — behind ReactFlow, matches pane pan/zoom.
          Only renders in the global Atlas scope; team-scoped instances
          (group chat) intentionally never show halos because the team
          identity is already obvious from context (you're inside that
          team's group chat). The sticky `showTeamHalos` store value is
          ignored here when scope is `'team'`, so toggling it from Atlas
          doesn't leak into other views. */}
      {scope === 'atlas' && showTeamHalos && <TeamHaloLayer nodes={nodes} />}

      {/* Atlas team-status clusters. Compact ● N pills above each
          team-root junction showing the breakdown of running / idle /
          sleeping / error agents. Always on in Atlas scope (live activity is
          a primary information signal). Pure rendering layer — does not
          touch nodes, edges, physics, or ELK. */}
      {scope === 'atlas' && <TeamStatusClusterLayer nodes={nodes} />}

      {/* ── Top-right command bar ─────────────────────────────────────────
          One glass shell (.surface-floating-tier) holding every action / mode
          tool in divider-separated clusters — LAYOUT · OVERLAYS · EDIT.
          Replaces the old five-mismatched-pill strip: icon-first + tooltips so
          the bar hugs the corner (~300px Atlas / ~88px team) instead of
          sprawling across the top. Conditional dividers keep the team subset
          gapless. */}
      <div
        role="toolbar"
        aria-label="Graph controls"
        aria-orientation="horizontal"
        className="surface-floating-tier"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: 4,
          borderRadius: 12,
        }}
      >
        {/* LAYOUT — re-run the ELK layout + (Atlas) the Tree|Radial mode pick.
            Re-layout is gated by `hasRunLayout` (nothing to re-layout before
            the first pass). */}
        {hasRunLayout && <BarBtn icon={RefreshCw} label="Re-layout" onClick={resetLayout} />}
        {scope === 'atlas' && (
          <>
            {hasRunLayout && <BarDivider />}
            <LayoutModeSegment value={atlasLayout} onChange={setAtlasLayout} />
          </>
        )}

        {/* OVERLAYS — Atlas-only on/off toggles (mint = overlay engaged). */}
        {scope === 'atlas' && (
          <>
            <BarDivider />
            <BarBtn
              icon={Pin}
              label="Team halos"
              tint="mint"
              active={showTeamHalos}
              onClick={() => setShowTeamHalos(!showTeamHalos)}
            />
            <BarBtn
              icon={Terminal}
              label={showActivityDock ? 'Hide activity feed' : 'Activity feed (all teams)'}
              tint="mint"
              active={showActivityDock}
              onClick={() => setShowActivityDock((v) => !v)}
            />
          </>
        )}

        {/* EDIT — draw routing edges (red = the single forward authoring
            action). Only prefix a divider when a cluster precedes it, so the
            team subset (`[Re-layout] · [Connect]`) never shows a leading rule. */}
        {(hasRunLayout || scope === 'atlas') && <BarDivider />}
        <BarBtn
          icon={GitBranch}
          label={connectMode ? 'Stop drawing edges' : 'Connect agents (draw routing)'}
          tint="primary"
          active={connectMode}
          onClick={() => setConnectMode(!connectMode)}
        />
      </div>

      {/* Atlas global activity dock — a right-edge slide-in panel. Always
          mounted so the slide animates both ways; the obs subscription only
          tails while open (`enabled`). */}
      {scope === 'atlas' && (
        <div
          className="surface-floating-tier"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 'min(380px, 82%)',
            zIndex: 25,
            display: 'flex',
            flexDirection: 'column',
            borderTopLeftRadius: 14,
            borderBottomLeftRadius: 14,
            transform: showActivityDock ? 'translateX(0)' : 'translateX(calc(100% + 24px))',
            transition: 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
            pointerEvents: showActivityDock ? 'auto' : 'none',
          }}
          aria-hidden={!showActivityDock}
        >
          <div
            style={{
              height: 44,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 14px',
              borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.08)',
            }}
          >
            <Terminal size={14} style={{ color: 'var(--mint)' }} />
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                fontFamily: 'var(--font-display)',
                letterSpacing: '-0.01em',
                color: 'var(--foreground)',
              }}
            >
              Activity
            </span>
            <span
              style={{
                fontSize: 11,
                color: 'rgb(var(--foreground-rgb) / 0.45)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              all teams
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              aria-label="Close activity"
              onClick={() => setShowActivityDock(false)}
              className="flex items-center justify-center rounded-md text-foreground/50 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
              style={{
                width: 28,
                height: 28,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <X size={16} />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: 12 }}>
            <ActivityTerminal scope={{}} fill hideHeader enabled={showActivityDock} />
          </div>
        </div>
      )}

      {/* Connect-mode armed ring — a subtle inset accent so edge-drawing mode
          reads across the whole canvas, not only the corner toggle. Below the
          toolbars (z-20), above the canvas; never intercepts pointer events. */}
      {connectMode && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 15,
            pointerEvents: 'none',
            boxShadow: 'inset 0 0 0 1.5px rgb(var(--primary-rgb) / 0.35)',
          }}
        />
      )}

      {/* ── Bottom-right viewport bar ──────────────────────────────────────
          Custom zoom / fit / lock / minimap in the SAME glass dialect as the
          top command bar — replaces the off-brand default React Flow
          <Controls> AND the lone minimap toggle, so all machine chrome speaks
          one language. Horizontal so it hugs the bottom-right corner without
          eating the short team-scope row. Present in both scopes. */}
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
          onClick={() => setLocked((l) => !l)}
        />
        <BarDivider />
        <BarBtn
          icon={showMiniMap ? X : Map}
          label={showMiniMap ? 'Hide minimap' : 'Show minimap'}
          tint="mint"
          active={showMiniMap}
          onClick={() => setShowMiniMap(!showMiniMap)}
        />
      </div>

      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        connectOnClick={true}
        connectionLineComponent={ConnectionLine}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
        minZoom={0.15}
        maxZoom={2.5}
        defaultEdgeOptions={{ animated: false }}
        // Interactivity lock (viewport bar). Freezes node dragging + selection
        // while leaving pan/zoom free — the design-system replacement for the
        // default <Controls> lock, which is why <Controls> is no longer rendered.
        nodesDraggable={!locked}
        elementsSelectable={!locked}
      >
        <Background variant={BackgroundVariant.Dots} gap={32} size={1} color="var(--canvas-dot)" />
        {showMiniMap && (
          <MiniMap
            // Float ABOVE the bottom-right viewport bar (40px tall + 12px inset
            // + 8px gap = 60) so the two never collide at the corner.
            position="bottom-right"
            style={{
              background: 'var(--canvas-control)',
              border: '1px solid var(--canvas-control-border)',
              borderRadius: 10,
              width: minimapDims.w,
              height: minimapDims.h,
              bottom: 60,
              right: 12,
              margin: 0,
            }}
            nodeColor={(node) => {
              if (node.type === 'boo') return 'var(--primary)'
              // Atlas team-root junctions are invisible — hide them in the
              // MiniMap too.
              if (node.type === 'team-root') return 'transparent'
              // Skill / resource nodes inherit visibility from their parent
              // Boo via `data.isVisible` (set by the visibleNodes memo).
              const isVisible = (node.data as { isVisible?: boolean }).isVisible ?? true
              if (node.type === 'skill') return isVisible ? 'var(--mint)' : 'transparent'
              if (node.type === 'resource') return isVisible ? 'var(--amber)' : 'transparent'
              return 'var(--amber)'
            }}
            nodeComponent={GhostGraphMiniMapNode}
            maskColor="var(--canvas-mask)"
          />
        )}
      </ReactFlow>

      {/* Context menu */}
      {contextMenu && (
        <GraphContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          agentId={contextMenu.agentId}
          agentName={contextMenu.agentName}
          onClose={() => setContextMenu(null)}
          onChat={() => {
            useFleetStore.getState().selectAgent(contextMenu.agentId)
            useViewStore.getState().openAgent(contextMenu.agentId)
            setContextMenu(null)
          }}
          onEditPersonality={() => {
            useFleetStore.getState().selectAgent(contextMenu.agentId)
            useViewStore.getState().openAgent(contextMenu.agentId)
            setContextMenu(null)
          }}
          onEditFiles={() => {
            useFleetStore.getState().selectAgent(contextMenu.agentId)
            useViewStore.getState().openAgent(contextMenu.agentId)
            setContextMenu(null)
          }}
          onSelectInSidebar={() => {
            // Highlight in fleet sidebar without opening the detail view
            // (preserved from the previous left-click behaviour, which
            // now toggles peacock expand instead).
            useFleetStore.getState().selectAgent(contextMenu.agentId)
            setContextMenu(null)
          }}
          onDelete={() => {
            const client = useConnectionStore.getState().client
            if (!client) return
            const agent = useFleetStore.getState().agents.find((a) => a.id === contextMenu.agentId)
            try {
              void deleteAgentOperation(contextMenu.agentId, agent?.sessionKey ?? null)
            } catch {
              // handled inside deleteAgentOperation
            }
            setContextMenu(null)
          }}
        />
      )}

      {/* Edge explain panel */}
      <AnimatePresence>
        {selectedEdge && (
          <EdgeExplainPanel
            edge={selectedEdge}
            onClose={() => setSelectedEdgeId(null)}
            onDelete={selectedEdge.type === 'dependency' ? handleDeleteEdge : null}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── EdgeExplainPanel ─────────────────────────────────────────────────────────

const EDGE_META = {
  skill: {
    label: 'Skill Connection',
    color: 'var(--mint)',
    desc: 'This agent has access to this tool.',
    file: 'Capabilities',
  },
  dependency: {
    label: 'Agent Dependency',
    color: 'var(--primary)',
    desc: 'This agent routes work to the target agent.',
    file: 'AGENTS.md',
  },
  resource: {
    label: 'Resource Connection',
    color: 'var(--amber)',
    desc: 'This agent uses this external service.',
    file: 'Capabilities',
  },
} as const

function EdgeExplainPanel({
  edge,
  onClose,
  onDelete,
}: {
  edge: GraphEdge
  onClose: () => void
  onDelete: ((edgeId: string) => void) | null
}) {
  const agentFiles = useGraphStore((s) => s.agentFiles)
  const agents = useFleetStore((s) => s.agents)

  const edgeType = (edge.type ?? 'skill') as keyof typeof EDGE_META
  const meta = EDGE_META[edgeType] ?? EDGE_META.skill

  const sourceAgentId = edge.source.startsWith('boo-') ? edge.source.slice(4) : null
  const sourceAgent = sourceAgentId ? agents.find((a) => a.id === sourceAgentId) : null
  const files = sourceAgentId ? agentFiles.get(sourceAgentId) : null
  // Skill/resource nodes come from the capability inventory now (no markdown
  // file to excerpt); only dependency edges have an AGENTS.md routing excerpt.
  const fileContent = edgeType === 'dependency' ? (files?.agentsMd ?? null) : null
  const excerpt = fileContent
    ? fileContent
        .split('\n')
        .find((l) => l.trim() && !l.startsWith('#'))
        ?.trim()
    : null

  return (
    <motion.div
      initial={{ y: 48, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 48, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      className="absolute bottom-4 left-1/2 z-10 w-[340px] -translate-x-1/2 rounded-xl border bg-canvas-control px-4 py-3.5 shadow-2xl"
      style={{
        borderColor: `${meta.color}40`,
        boxShadow: `var(--shadow-floating), 0 0 0 0.5px ${meta.color}30`,
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold" style={{ color: meta.color }}>
          {meta.label}
        </span>
        <IconButton label="Close" variant="ghost" size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <p className="m-0 mb-2 text-[12px] text-foreground/55">{meta.desc}</p>
      {sourceAgent && (
        <div className="rounded-md bg-foreground/[0.04] px-2.5 py-1.5 text-[12px]">
          <span className="text-foreground/40">Source: </span>
          <span className="font-medium text-foreground">{sourceAgent.name}</span>
          <span className="text-foreground/40"> · via {meta.file}</span>
        </div>
      )}
      {excerpt && (
        <p className="mt-2 mb-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-foreground/30">
          {excerpt}
        </p>
      )}
      {onDelete && (
        <div className="mt-2.5">
          <Button variant="danger" size="sm" fullWidth onClick={() => onDelete(edge.id)}>
            Remove Connection
          </Button>
        </div>
      )}
    </motion.div>
  )
}
