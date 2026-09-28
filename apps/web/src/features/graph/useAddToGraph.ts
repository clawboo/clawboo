import { useCallback, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Edge, Node, XYPosition } from '@xyflow/react'
import { connectorBySlug } from '@clawboo/connector-catalog'

import { useBrokeredApps } from '@/features/connectors/useBrokeredApps'
import { useConnectorCostState } from '@/features/connectors/useConnectorCostState'
import { connectConnector, signInConnector } from '@/features/marketplace/connectConnector'

import {
  describeLoose,
  findFreeSpot,
  isLooseNodeId,
  LOOSE_TILE,
  looseScale,
  makeLooseNode,
  obstaclesFrom,
  segmentsFrom,
  spotIsFree,
  useLooseNodes,
  useLooseNodeStore,
  type Bounds,
  type LooseKind,
  type Obstacle,
} from './looseNodes'
import { spawnAgent } from './operations/spawnNode'
import type { ThreadOption } from './ThreadPicker'
import { threadOptionsFor } from './threadOptions'

// ─── The + button ────────────────────────────────────────────────────────────
//
// The same picker a thread let go on empty canvas opens, asked with no agent
// behind it. What the pick makes lands just below the button, clear of every
// node and line already there, and attached to nothing:
//
//   a skill or connector → a loose node (see looseNodes.ts), with a port, for a
//                          later drag onto whichever agent should have it
//   a new agent          → a Boo, in the canvas's team, with no routes yet
//
// Connectors are still turned on here when they need to be: a loose connector
// that was not running would be a promise the drag could not keep.

/** A Boo's footprint is a 280 square; the Boo itself is about this wide. */
const BOO_FOOTPRINT = 280
const BOO_RADIUS = 70

/** A press on the button that just closed the picker must not reopen it. */
const REOPEN_GUARD_MS = 250

/** Screen pixels kept clear at the canvas edges, and under the bottom bar. */
const EDGE_MARGIN = 48
const BOTTOM_MARGIN = 72

const NONE: ReadonlySet<string> = new Set()

export interface UseAddToGraphOptions {
  /** Which canvas the loose nodes belong to. */
  canvasKey: string
  /** Everything the canvas draws right now, to keep a new node clear of it. */
  getNodes: () => Node[]
  getEdges: () => Edge[]
  getZoom: () => number
  screenToFlowPosition: (point: XYPosition) => XYPosition
  /** The canvas element: a new node lands inside what it shows. */
  paneRef: RefObject<HTMLElement | null>
  /** The bar the + button sits in: the picker opens under it, and so do new nodes. */
  barRef: RefObject<HTMLElement | null>
  /** The team a new agent joins, or null where this canvas cannot show one. */
  newAgentTeamId: string | null
}

export function useAddToGraph({
  canvasKey,
  getNodes,
  getEdges,
  getZoom,
  screenToFlowPosition,
  paneRef,
  barRef,
  newAgentTeamId,
}: UseAddToGraphOptions) {
  /** Where the picker opens, in screen pixels, or null while it is closed. */
  const [anchor, setAnchor] = useState<XYPosition | null>(null)
  const closedAt = useRef(0)

  const { costOf, refresh: refreshConnectorCosts } = useConnectorCostState()
  const { apps } = useBrokeredApps()
  const loose = useLooseNodes(canvasKey)

  const options = useMemo(() => {
    if (!anchor) return []
    return threadOptionsFor({
      fromNodeType: null,
      mode: 'free',
      onCanvas: new Set(loose.map((n) => n.id)),
      ownedSkillNames: NONE,
      liveConnectorSlugs: NONE,
      costOf: (def) => costOf(def),
      brokeredApps: apps,
    })
  }, [anchor, loose, costOf, apps])

  const close = useCallback(() => {
    closedAt.current = performance.now()
    setAnchor(null)
  }, [])

  /**
   * Open the picker under the bar, or close it when it is open.
   *
   * THE GUARD: the picker closes on any press outside it, the button included,
   * and that press's click lands right after. Without the guard the button
   * could never close what it opened; it would close and reopen in one press.
   */
  const toggle = useCallback(() => {
    if (anchor || performance.now() - closedAt.current < REOPEN_GUARD_MS) {
      close()
      return
    }
    const bar = barRef.current?.getBoundingClientRect()
    // Re-price on open, as the thread picker does: what a connector costs came
    // from a snapshot, and the shelf may have changed it since.
    refreshConnectorCosts()
    setAnchor(bar ? { x: bar.left, y: bar.bottom + 8 } : { x: 16, y: 64 })
  }, [anchor, barRef, close, refreshConnectorCosts])

  /**
   * What is on screen, in graph units, and the spot under the + button that
   * new nodes start from. The band above the bar's bottom edge is left out, so
   * nothing lands behind the bar.
   *
   * UNDER THE BUTTON ITSELF, which leads the bar, rather than the bar's far
   * end. The far end is the canvas's right edge: a tile there had its hint cut
   * off, and a drag from its port started inside React Flow's auto-pan margin,
   * so the canvas slid away under the thread before it could land.
   */
  const frame = useCallback((): { bounds: Bounds; under: XYPosition } => {
    const pane = paneRef.current?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    }
    const bar = barRef.current?.getBoundingClientRect()
    const top = Math.max(pane.top + EDGE_MARGIN, (bar?.bottom ?? pane.top) + 24)
    const min = screenToFlowPosition({ x: pane.left + EDGE_MARGIN, y: top })
    const max = screenToFlowPosition({
      x: pane.right - EDGE_MARGIN,
      y: pane.bottom - BOTTOM_MARGIN,
    })
    const under = screenToFlowPosition({
      // The + button's centre: the bar's padding plus half a 32px button.
      x: bar ? bar.left + 20 : pane.right - EDGE_MARGIN * 4,
      y: top + 56,
    })
    return { bounds: { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y }, under }
  }, [paneRef, barRef, screenToFlowPosition])

  /**
   * The CENTRE of a free spot for something of radius `r`: as close under the
   * + button as the canvas allows, inside what is on screen, off every node
   * and line. See looseNodes.ts.
   */
  const spawnCenter = useCallback(
    (r: number): XYPosition => {
      const { bounds, under } = frame()
      const nodes = getNodes()
      const zoom = getZoom()
      return findFreeSpot(
        under,
        r,
        obstaclesFrom(nodes, zoom),
        segmentsFrom(nodes, getEdges()),
        bounds,
      )
    },
    [frame, getNodes, getEdges, getZoom],
  )

  /** A loose tile's radius as drawn right now, which the floor may have grown. */
  const looseRadius = useCallback(() => (LOOSE_TILE / 2) * looseScale(getZoom()), [getZoom])

  /**
   * Bring every loose node that is off screen, or now sits on something, back
   * under the + button. For after a layout moves the graph and the camera: a
   * loose node keeps its place in the old picture, which is somewhere else in
   * the new one. The ones still on screen and clear stay where they were put.
   */
  const reseat = useCallback(() => {
    const store = useLooseNodeStore.getState()
    const loose = store.byCanvas[canvasKey] ?? []
    if (loose.length === 0) return
    const { bounds, under } = frame()
    const zoom = getZoom()
    const others = getNodes().filter((n) => !isLooseNodeId(n.id))
    const taken: Obstacle[] = obstaclesFrom(others, zoom)
    const lines = segmentsFrom(others, getEdges())
    // The box is 46 whatever the zoom; the drawing is what must not overlap.
    const box = LOOSE_TILE / 2
    const r = looseRadius()
    const moves = new Map<string, XYPosition>()
    for (const n of loose) {
      const at = { x: n.position.x + box, y: n.position.y + box }
      const spot = spotIsFree(at, r, taken, lines, bounds)
        ? at
        : findFreeSpot(under, r, taken, lines, bounds)
      taken.push({ x: spot.x, y: spot.y, r: r + 10 })
      if (spot !== at) moves.set(n.id, { x: spot.x - box, y: spot.y - box })
    }
    store.reposition(canvasKey, moves)
  }, [canvasKey, frame, getNodes, getEdges, getZoom, looseRadius])

  const place = useCallback(
    (kind: LooseKind, ref: string) => {
      const described = describeLoose(kind, ref)
      if (!described) return
      const c = spawnCenter(looseRadius())
      useLooseNodeStore
        .getState()
        .add(
          canvasKey,
          makeLooseNode(canvasKey, described, { x: c.x - LOOSE_TILE / 2, y: c.y - LOOSE_TILE / 2 }),
        )
    },
    [canvasKey, spawnCenter, looseRadius],
  )

  const pick = useCallback(
    async (option: ThreadOption) => {
      setAnchor(null)
      if (option.id.startsWith('skill:')) {
        place('skill', option.id.slice('skill:'.length))
        return
      }
      if (option.id.startsWith('brokered:')) {
        place('app', option.id.slice('brokered:'.length))
        return
      }
      if (!option.id.startsWith('connector:')) return
      const slug = option.id.slice('connector:'.length)
      const def = connectorBySlug(slug)
      if (!def) return
      const cost = costOf(def)
      let on = cost === 'on'
      if (!on) {
        if (cost === 'one-click') {
          if (await signInConnector(def.slug, def.displayName)) {
            on = (await connectConnector(def.slug, def.displayName)) !== null
          }
        } else {
          on = (await connectConnector(def.slug, def.displayName)) !== null
        }
        refreshConnectorCosts()
      }
      if (on) place('connector', slug)
    },
    [costOf, place, refreshConnectorCosts],
  )

  const createAgent = useCallback(
    async (name: string) => {
      setAnchor(null)
      if (!newAgentTeamId) return
      const c = spawnCenter(BOO_RADIUS)
      // A Boo's position is the top-left of its footprint, with the Boo centred.
      await spawnAgent(
        name,
        { x: c.x - BOO_FOOTPRINT / 2, y: c.y - BOO_FOOTPRINT / 2 },
        { teamId: newAgentTeamId },
      )
    },
    [newAgentTeamId, spawnCenter],
  )

  return { anchor, options, toggle, close, pick, createAgent, reseat }
}
