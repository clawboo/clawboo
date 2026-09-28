import { create } from 'zustand'
import { applyNodeChanges } from '@xyflow/react'
import type { Node, NodeChange, XYPosition } from '@xyflow/react'
import { apiFetch } from '@clawboo/control-client'
import { BROKERED_APPS, connectorBySlug } from '@clawboo/connector-catalog'

import { BUILTIN_SKILLS } from '@/features/marketplace/catalog'

import type { SkillCategory } from './types'
import { minScreenScale } from './useMinScreenSize'

// ─── Loose nodes ─────────────────────────────────────────────────────────────
//
// A loose node is a skill or a connector placed on a canvas with the + button,
// attached to no agent yet. It carries the same port a Boo does; dragging a
// thread from it onto a Boo gives that agent the thing, and the loose node goes
// (it now orbits the agent, like any other capability).
//
// WHY A LAYER OF ITS OWN, not a node in the graph store: `useGraphData` rebuilds
// the store's node array from server truth on every refresh, and the layout
// effect feeds that array to ELK. A node the server has never heard of would be
// wiped by the first rebuild, and one that survived would be laid out as if it
// belonged to somebody. So each canvas keeps its loose nodes here and merges
// them into what React Flow draws; the layout never sees them.
//
// WHAT IS SAVED is only where each one sits, keyed by an id that already names
// the thing (`loose:skill:web-search`), through the same named-layout store the
// canvas uses for its own positions, under a name of its own (`loose-<canvas>`).
// A re-layout clears the canvas's positions and never touches these. Nothing
// here claims an agent has anything, so there is no server truth to disagree
// with: the moment one is attached, it is gone from this list and the agent's
// capability tile, which the server does own, takes its place.

/** What a loose node stands for. `app` is an app reached through a broker. */
export type LooseKind = 'skill' | 'connector' | 'app'

const KINDS: readonly LooseKind[] = ['skill', 'connector', 'app']

/** The prefix every loose node id starts with. Never collides with `boo-` etc. */
export const LOOSE_PREFIX = 'loose:'

/** The tile's diameter, in graph units. Matches the orbital tiles. */
export const LOOSE_TILE = 46
/** The smallest a loose tile ever draws on screen, in CSS pixels. As the team badges. */
export const LOOSE_MIN_SCREEN = 28

/** How much a loose tile grows to keep its on-screen floor at this zoom. */
export function looseScale(zoom: number): number {
  return minScreenScale(LOOSE_TILE, LOOSE_MIN_SCREEN, zoom)
}

/** What a loose node shows, derived from its kind and ref alone. */
export type LooseDescription = {
  kind: LooseKind
  /** A skill id, a connector slug, or a broker toolkit. */
  ref: string
  name: string
  description?: string
  /** The connector whose logo to draw. */
  slug?: string
  /** A skill's category, which picks its glyph. */
  category?: SkillCategory
  /** The tile's accent, which the thread also takes (see `previewColor`). */
  accent: string
}

export type LooseNodeData = LooseDescription & {
  /** Which canvas owns it, so the node can remove itself. */
  canvasKey: string
}

export type LooseNode = Node<LooseNodeData, 'loose'>

export function looseNodeId(kind: LooseKind, ref: string): string {
  return `${LOOSE_PREFIX}${kind}:${ref}`
}

/** The kind and ref an id encodes, or null for anything that is not one. */
export function parseLooseNodeId(id: string): { kind: LooseKind; ref: string } | null {
  if (!id.startsWith(LOOSE_PREFIX)) return null
  const rest = id.slice(LOOSE_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  const kind = rest.slice(0, colon) as LooseKind
  const ref = rest.slice(colon + 1)
  if (!KINDS.includes(kind) || !ref) return null
  return { kind, ref }
}

export function isLooseNodeId(id: string): boolean {
  return id.startsWith(LOOSE_PREFIX)
}

/** The accent each kind wears: the same type colours the orbital tiles use. */
export function looseAccent(kind: LooseKind): string {
  return kind === 'skill' ? 'var(--mint)' : 'var(--violet)'
}

/**
 * The display half of a loose node, from its kind and ref alone.
 *
 * Null when the ref no longer resolves (a skill dropped from the catalog, a
 * custom connector since deleted), so a stale entry is skipped rather than
 * drawn as a blank tile nobody can identify. An app the broker catalog no
 * longer lists still draws, under its toolkit name, because the grant it would
 * make is keyed on that.
 */
export function describeLoose(kind: LooseKind, ref: string): LooseDescription | null {
  if (kind === 'skill') {
    const skill = BUILTIN_SKILLS.find((s) => s.id === ref)
    if (!skill) return null
    return {
      kind,
      ref,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      accent: looseAccent(kind),
    }
  }
  if (kind === 'connector') {
    const def = connectorBySlug(ref)
    if (!def) return null
    return {
      kind,
      ref,
      name: def.displayName,
      description: def.description,
      slug: def.slug,
      accent: looseAccent(kind),
    }
  }
  const app = BROKERED_APPS.find((a) => a.toolkit === ref)
  return {
    kind,
    ref,
    name: app?.name ?? ref,
    ...(app ? { description: app.description, slug: app.slug } : {}),
    accent: looseAccent(kind),
  }
}

/**
 * The node React Flow draws.
 *
 * A FIXED BOX, AND ALREADY MEASURED. React Flow counts a canvas as initialised
 * only once every node carries `measured`, and the Ghost Graph's layout waits
 * on that. A loose node that arrived unmeasured would flip the whole canvas
 * back to "not initialised" until its first resize report landed. `width` and
 * `height` pin the wrapper to exactly this size, so the preset is true.
 */
export function makeLooseNode(
  canvasKey: string,
  described: LooseDescription,
  position: XYPosition,
): LooseNode {
  const what = described.kind === 'skill' ? 'Skill' : 'Connector'
  return {
    id: looseNodeId(described.kind, described.ref),
    type: 'loose',
    position,
    data: { ...described, canvasKey },
    ariaLabel: `${what} ${described.name}, not attached to an agent`,
    width: LOOSE_TILE,
    height: LOOSE_TILE,
    measured: { width: LOOSE_TILE, height: LOOSE_TILE },
  }
}

// ─── Where a new one lands ───────────────────────────────────────────────────
//
// UNDER THE + BUTTON, not in the middle of the graph. The middle is where the
// graph is: Boo Zero sits there in radial, and the first free ring around it
// crossed one of its branches. Just below the button is where the operator was
// looking when they picked, and the corner a fitted graph leaves emptiest.

/** A node to keep clear of: a centre and a radius, in graph units. */
export interface Obstacle {
  x: number
  y: number
  r: number
}

/** A drawn line to keep clear of, in graph units. */
export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Where a new node may land, in graph units: the part of the canvas on screen. */
export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** How far apart two nodes must be to read as separate, beyond their radii. */
const CLEARANCE = 24
/** A tile only has to not sit on a line, so a line needs less room than a node. */
const LINE_CLEARANCE = 14

export function distanceToSegment(p: XYPosition, s: Segment): number {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len2 = dx * dx + dy * dy
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2))
  return Math.hypot(p.x - (s.x1 + t * dx), p.y - (s.y1 + t * dy))
}

/**
 * The free spot nearest `anchor` for a node of radius `r`: clear of every
 * obstacle and every line, and inside `bounds`.
 *
 * Candidates on a grid a node-width apart, tried nearest-first, so a second
 * node lands beside the first rather than on it. Deterministic, so the same
 * canvas places the same way twice. When nothing on screen is free it falls
 * back to the anchor: overlapping is better than landing out of sight.
 */
export function findFreeSpot(
  anchor: XYPosition,
  r: number,
  obstacles: readonly Obstacle[],
  segments: readonly Segment[],
  bounds: Bounds,
): XYPosition {
  const free = (p: XYPosition): boolean => spotIsFree(p, r, obstacles, segments, bounds)
  if (free(anchor)) return anchor
  const step = r * 2 + CLEARANCE
  const candidates: XYPosition[] = []
  for (let x = bounds.minX + r; x <= bounds.maxX - r; x += step) {
    for (let y = bounds.minY + r; y <= bounds.maxY - r; y += step) candidates.push({ x, y })
  }
  const far = (p: XYPosition): number => Math.hypot(p.x - anchor.x, p.y - anchor.y)
  candidates.sort((a, b) => far(a) - far(b))
  return candidates.find(free) ?? anchor
}

/** Whether a node of radius `r` centred at `p` is on screen and on nothing. */
export function spotIsFree(
  p: XYPosition,
  r: number,
  obstacles: readonly Obstacle[],
  segments: readonly Segment[],
  bounds: Bounds,
): boolean {
  const inside =
    p.x - r >= bounds.minX &&
    p.x + r <= bounds.maxX &&
    p.y - r >= bounds.minY &&
    p.y + r <= bounds.maxY
  return (
    inside &&
    obstacles.every((o) => Math.hypot(o.x - p.x, o.y - p.y) >= o.r + r + CLEARANCE) &&
    segments.every((s) => distanceToSegment(p, s) >= r + LINE_CLEARANCE)
  )
}

/** A node as the placement helpers read it: where it is and how big. */
export interface Placed {
  id: string
  type?: string
  position: XYPosition
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
}

/** A node's centre, in graph units: where its lines meet it. */
export function centreOf(n: Placed): XYPosition {
  const w = n.measured?.width ?? n.width ?? 0
  const h = n.measured?.height ?? n.height ?? 0
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 }
}

/**
 * What a canvas already holds, as obstacles: every node's visual centre and a
 * radius that covers what it draws. A Boo's box is a 280 square with the Boo in
 * the middle, so its radius is the Boo, not the box; a loose tile draws larger
 * than its box when zoomed out, so its radius is the drawing at `zoom`.
 */
export function obstaclesFrom(nodes: readonly Placed[], zoom = 1): Obstacle[] {
  return nodes.map((n) => {
    const w = n.measured?.width ?? n.width ?? LOOSE_TILE
    const h = n.measured?.height ?? n.height ?? LOOSE_TILE
    const r =
      n.type === 'boo'
        ? 70
        : n.type === 'team-root'
          ? 30
          : n.type === 'loose'
            ? (LOOSE_TILE / 2) * looseScale(zoom) + 10
            : Math.max(w, h) / 2 + 10
    const c = centreOf({ ...n, width: w, height: h, measured: undefined })
    return { x: c.x, y: c.y, r }
  })
}

/**
 * The lines a canvas draws at rest, as segments between node centres, each in
 * the shape DependencyEdge draws it.
 *
 * A routing edge is a step (down to halfway, across, down) everywhere except
 * radial Atlas, where it runs straight; each edge carries which in its
 * `layoutMode`. An orbital line is a gentle curve, taken as straight. Lines
 * that only show on hover, and orbital lines of a closed ring, are not on
 * screen and do not count.
 */
export function segmentsFrom(
  nodes: readonly Placed[],
  edges: readonly {
    source: string
    target: string
    type?: string
    hidden?: boolean
    data?: unknown
  }[],
): Segment[] {
  const centres = new Map(nodes.map((n) => [n.id, centreOf(n)]))
  const out: Segment[] = []
  for (const e of edges) {
    if (e.hidden) continue
    const d = e.data as
      { isVisible?: boolean; isPrimary?: boolean; layoutMode?: string } | undefined
    if (d?.isVisible === false) continue
    if (e.type === 'dependency' && d?.isPrimary === false) continue
    const a = centres.get(e.source)
    const b = centres.get(e.target)
    if (!a || !b) continue
    if (e.type === 'dependency' && d?.layoutMode !== 'radial') {
      const midY = (a.y + b.y) / 2
      out.push({ x1: a.x, y1: a.y, x2: a.x, y2: midY })
      out.push({ x1: a.x, y1: midY, x2: b.x, y2: midY })
      out.push({ x1: b.x, y1: midY, x2: b.x, y2: b.y })
    } else {
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
    }
  }
  return out
}

// ─── The store ───────────────────────────────────────────────────────────────

/** The saved half, as the layout store keeps it: id to position. */
type SavedLoose = Record<string, XYPosition>

interface LooseNodeStore {
  /** Each canvas's loose nodes, in the shape React Flow draws. */
  byCanvas: Record<string, LooseNode[]>
  /** The scope the saved layout is keyed under (the Gateway URL, or ''). */
  scopeUrl: string
  /** Read a canvas's saved loose nodes. Safe to call repeatedly. */
  load: (canvasKey: string, scopeUrl: string) => Promise<void>
  /** Put one on a canvas. A second copy of the same thing is refused. */
  add: (canvasKey: string, node: LooseNode) => boolean
  remove: (canvasKey: string, id: string) => void
  /** Move a canvas's nodes to new positions at once, and save. */
  reposition: (canvasKey: string, positions: ReadonlyMap<string, XYPosition>) => void
  /** React Flow's own changes (drag, measure, select) for this canvas's nodes. */
  applyChanges: (canvasKey: string, changes: NodeChange[]) => void
  /** Save where they sit now. Called on drag stop, add and remove. */
  persist: (canvasKey: string) => void
}

/** The layout name a canvas's loose nodes are saved under. */
export function looseLayoutName(canvasKey: string): string {
  return `loose-${canvasKey}`
}

const EMPTY: LooseNode[] = []

/** A canvas's loose nodes, stable across renders when nothing changed. */
export function useLooseNodes(canvasKey: string): LooseNode[] {
  return useLooseNodeStore((s) => s.byCanvas[canvasKey] ?? EMPTY)
}

export const useLooseNodeStore = create<LooseNodeStore>((set, get) => ({
  byCanvas: {},
  scopeUrl: '',

  load: async (canvasKey, scopeUrl) => {
    set({ scopeUrl })
    let saved: SavedLoose = {}
    try {
      const res = await apiFetch(
        `/api/graph-layout?name=${encodeURIComponent(looseLayoutName(canvasKey))}&url=${encodeURIComponent(scopeUrl)}`,
      )
      if (res.ok) {
        const body = (await res.json()) as { positions?: SavedLoose }
        saved = body.positions ?? {}
      }
    } catch {
      // Nothing saved reads the same as nothing loose: an empty canvas layer.
    }
    const nodes: LooseNode[] = []
    for (const [id, position] of Object.entries(saved)) {
      const parsed = parseLooseNodeId(id)
      if (!parsed) continue
      const described = describeLoose(parsed.kind, parsed.ref)
      if (!described) continue
      nodes.push(makeLooseNode(canvasKey, described, position))
    }
    // Anything added while the read was in flight wins over what was saved.
    set((s) => {
      const pending = s.byCanvas[canvasKey] ?? []
      const ids = new Set(pending.map((n) => n.id))
      return {
        byCanvas: {
          ...s.byCanvas,
          [canvasKey]: [...nodes.filter((n) => !ids.has(n.id)), ...pending],
        },
      }
    })
  },

  add: (canvasKey, node) => {
    const current = get().byCanvas[canvasKey] ?? []
    if (current.some((n) => n.id === node.id)) return false
    set((s) => ({ byCanvas: { ...s.byCanvas, [canvasKey]: [...current, node] } }))
    get().persist(canvasKey)
    return true
  },

  remove: (canvasKey, id) => {
    const current = get().byCanvas[canvasKey] ?? []
    if (!current.some((n) => n.id === id)) return
    set((s) => ({
      byCanvas: { ...s.byCanvas, [canvasKey]: current.filter((n) => n.id !== id) },
    }))
    get().persist(canvasKey)
  },

  reposition: (canvasKey, positions) => {
    const current = get().byCanvas[canvasKey] ?? []
    if (positions.size === 0) return
    set((s) => ({
      byCanvas: {
        ...s.byCanvas,
        [canvasKey]: current.map((n) => {
          const to = positions.get(n.id)
          return to ? { ...n, position: to } : n
        }),
      },
    }))
    get().persist(canvasKey)
  },

  applyChanges: (canvasKey, changes) => {
    const current = get().byCanvas[canvasKey]
    if (!current || changes.length === 0) return
    const next = applyNodeChanges(changes, current) as LooseNode[]
    set((s) => ({ byCanvas: { ...s.byCanvas, [canvasKey]: next } }))
  },

  persist: (canvasKey) => {
    const nodes = get().byCanvas[canvasKey] ?? []
    const positions: SavedLoose = {}
    for (const n of nodes) positions[n.id] = { x: n.position.x, y: n.position.y }
    void apiFetch('/api/graph-layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: looseLayoutName(canvasKey),
        positions,
        gatewayUrl: get().scopeUrl,
      }),
    }).catch(() => {
      // Best-effort, like every position save: the node is on screen either way.
    })
  },
}))
