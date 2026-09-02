import { memo, useRef, type MutableRefObject } from 'react'
import { Handle, Position, useConnection } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { motion, useReducedMotion } from 'framer-motion'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import type { BooNodeData } from '../types'
import { useGraphStore } from '../store'
import { useFloatingMotion } from '../useFloatingMotion'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useObsOverlayStore } from '@/stores/obsOverlay'
import { BooThoughtBubble } from './BooThoughtBubble'
import { RuntimeBadge } from './RuntimeBadge'
import { createFlipState, useFlipMorph, type FlipState } from './useFlipMorph'
import { useChatStore } from '@/stores/chat'
import { getActivityVerb } from '@/lib/agentActivityVerb'

// ─── BooNode — the mascot, always ────────────────────────────────────────────
//
//                        ╭─────────────────────╮
//                    ○ ○ │ editing pricing.css │  ← BooThoughtBubble, while running
//          ┌────┐        ╰─────────────────────╯
//          │ ◯  │   ← degree-aware circle (60–140px), avatar fills the disc
//          └────┘
//             Name           ← absolute below
//             ● status       ← absolute below name
//             seen 2m ago    ← absolute below status (only when not running)
//
// It used to morph into a 280x170 CARD while running. That cost the mascot its
// identity at exactly the moment it was most interesting — the character shrank
// to a 30px corner icon — and spent most of its area on nothing, because the
// only thing the card showed that the circle does not already render beneath
// itself is ONE line of activity. That line now lives in a thought bubble sized
// to its own contents, and the Boo stays a Boo.
//
// The wrapper's width / height / border-radius use a CSS transition for the
// size-and-shape morph (~280ms cubic-bezier). Inside, the avatar / name /
// status sub-elements use a manual FLIP technique (see `useFlipMorph.ts`)
// to slide between their card-mode and circle-mode positions rather than
// snap. Card-only chrome (header dividers, live activity feed) and
// circle-only chrome (last-seen) conditionally render.
//
// **Why no FM `layout` / `layoutId`** (load-bearing): `ContentArea` wraps the
// active view in `<AnimatePresence mode="wait">`. Framer Motion's layout
// system tracks elements globally, so a `layoutId` set on a child of one
// AnimatePresence panel can match a `layoutId` on a child of the next panel.
// `BooNode` is mounted in BOTH `GhostGraphPanel` AND `MiniGraph`
// (via the shared `nodeTypes`), so the same agent's `boo-${agentId}-…`
// `layoutId`s exist in two render trees during the cross-fade — colliding
// across the AnimatePresence boundary, jamming `mode="wait"`'s exit cycle,
// and leaving the previous view (Ghost Graph) on screen so chat / agent
// detail / group chat panels never mount. CSS transitions + manual FLIP are
// scoped per element / per BooNode instance and don't interact with parent
// route transitions, so they're the safe morph mechanism here.
//
// The thought bubble renders <BooThoughtBubble> — the latest assistant
// message, in-flight streaming text, or formatted tool call. The footer is
// intentionally empty (team identity is conveyed by `TeamHaloLayer` and the
// sidebar). Team badge has been removed from the BooNode entirely.

// ─── Card dimensions (kept in sync with computeElkLayout) ────────────────────
export const BOO_CARD_WIDTH = 280
export const BOO_CARD_HEIGHT = 170

// ─── Node footprint (matches ELK envelope in useGraphLayout.ts) ──────────────
// The Boo renders centered inside this footprint so its visual center aligns
// with the React Flow node's geometric center — which is what ELK plans for
// when laying out edges and sibling spacing. Without this, the rendered shape
// (75–78px circle or 220×120 card) sits at the top-left of the envelope and
// edges visually converge offset from the Boo.
//
// Sized to fit the card (220×120, diagonal half ~125 px) plus an inner skill
// ring at ~150 px from center. Outer skill rings (up to ~220 px) can briefly
// overlap a sibling's gap region when BOTH neighbours are expanded — that's
// an acceptable trade-off for the dramatic boost in idle Boo legibility:
// scale on a 3-Boo group-chat row goes from ~0.49 to ~0.68 (~40 % bigger).
const BOO_FOOTPRINT = 280

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatLastSeen(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) return null
  const diff = Date.now() - lastSeenAt
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ─── Status → glow / dot / label ─────────────────────────────────────────────

type GlowConfig = { color: string; pulse: boolean }

// Chromatic only. These are now `drop-shadow` colours on the mascot's
// silhouette, and a theme-inverting token is a trap there: `--foreground-rgb`
// is near-white in dark mode, so `sleeping` used to bloom a white halo around
// the one agent that should be receding. Sleeping is handled by
// `.boo-cast--sleeping` (desaturation) instead of by a glow.
const STATUS_GLOW: Record<string, GlowConfig | null> = {
  idle: null,
  running: { color: 'rgb(var(--mint-rgb) / 0.55)', pulse: true },
  error: { color: 'rgb(var(--destructive-rgb) / 0.55)', pulse: false },
  // No glow for sleeping. A glow ADDS light, so it can only make a dormant agent
  // MORE prominent than a working one, and `--foreground-rgb` inverts between
  // themes, which bloomed a white halo on the dark canvas. `.boo-cast--sleeping`
  // desaturates instead, which is the one treatment that reads as resting.
  sleeping: null,
}

// Error and sleeping used to share amber, which made "this needs you" and "this is
// deliberately resting" the same mark. Error takes the destructive red the rest of
// the product already uses for failure; sleeping keeps the quiet neutral it means.
const STATUS_DOT: Record<string, string> = {
  idle: 'var(--category-other)',
  running: 'var(--mint)',
  error: 'var(--destructive)',
  sleeping: 'var(--category-other)',
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  running: 'active',
  error: 'error',
  sleeping: 'sleeping',
}

// ─── Handle styles ───────────────────────────────────────────────────────────

const handleBase: React.CSSProperties = {
  background: 'transparent',
  border: '1.5px solid rgb(var(--foreground-rgb) / 0.22)',
  width: 8,
  height: 8,
  transition: 'opacity 0.15s, background 0.15s, width 0.15s, height 0.15s',
}

const handleConnecting: React.CSSProperties = {
  background: 'rgb(var(--primary-rgb) / 0.5)',
  border: '1px solid rgb(var(--primary-rgb) / 0.3)',
  width: 12,
  height: 12,
  borderRadius: '50%',
  transition: 'opacity 0.15s, background 0.15s, width 0.15s, height 0.15s',
}

/**
 * The always-visible port.
 *
 * Sized for a pointer rather than for tidiness: 20px is the smallest disc that
 * reads as a target at the zoom levels the canvas actually sits at, and the
 * three handles it replaces were 8px.
 */
const portStyle: React.CSSProperties = {
  background: 'rgb(var(--surface-rgb, 255 255 255) / 1)',
  border: '1.5px solid rgb(var(--foreground-rgb) / 0.28)',
  width: 20,
  height: 20,
  borderRadius: '50%',
  transition: 'background 0.15s, border-color 0.15s, transform 0.15s',
}

/** Engaged: the thread is out, or connect mode is on. */
const portStyleActive: React.CSSProperties = {
  ...portStyle,
  background: 'rgb(var(--primary-rgb) / 0.12)',
  border: '1.5px solid rgb(var(--primary-rgb))',
  transform: 'scale(1.1)',
}

const centerHandleStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  opacity: 0,
  pointerEvents: 'none',
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
}

// CSS transition for the wrapper size + border-radius morph. The
// cubic-bezier(0.32, 0.72, 0, 1) curve is the app's signature "premium"
// ease-out (same one the activity dock slide uses) — a fast start with a
// long, soft landing. Opacity (the hover-cascade dim) rides the same curve
// slightly longer so dimming reads as a fade, not a flick.
const SHAPE_TRANSITION =
  'width 0.32s cubic-bezier(0.32, 0.72, 0, 1), ' +
  'height 0.32s cubic-bezier(0.32, 0.72, 0, 1), ' +
  'border-radius 0.32s cubic-bezier(0.32, 0.72, 0, 1), ' +
  'background 0.2s ease, ' +
  'border-color 0.15s ease, ' +
  'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1)'

// ─── BooNode ─────────────────────────────────────────────────────────────────

export const BooNode = memo(function BooNode({
  data,
  selected,
  dragging,
}: NodeProps<Node<BooNodeData, 'boo'>>) {
  const { agentId, name, status, ringCounts } = data
  // SELECTOR, not the whole store: BooNode renders once per agent, and a
  // whole-store subscription would re-render every Boo on any graph change.
  const isExpanded = useGraphStore((s) => s.expandedBooNodeIds.has(`boo-${agentId}`))
  const floatRef = useFloatingMotion(agentId, 'boo', dragging)
  // Decorative hover lift — dropped under reduced motion (see SkillNode).
  const reduceMotion = useReducedMotion()
  const isRunning = status === 'running'
  // The bubble is how a Boo says what it is doing, and an error is the thing a
  // person most needs to read. Gating it on `running` alone meant the moment a
  // run failed the bubble unmounted, taking `useBooActivity`'s error line with
  // it, so that branch could never be seen by anyone. An errored Boo keeps its
  // bubble so the reason stays on screen.
  const showsBubble = isRunning || status === 'error'
  // The Boo NEVER becomes a card any more. The card cost the mascot its
  // identity exactly when it was most interesting, and the only thing it showed
  // that the circle does not already render beneath itself is one line of
  // activity — which now lives in `BooThoughtBubble` above its head, sized to
  // its own contents. Kept as a named constant rather than deleting the card
  // branches in one pass: every consumer of it collapses to the idle shape, so
  // the FLIP morph, the name/status placement and the halo all keep working.
  const showCard = false
  // Runtime brand badge — shown on every Boo (Atlas + team graph + agent-detail
  // MiniGraph) so the agent's runtime is legible at a glance.
  const runtime = data.runtime

  // FLIP state for the avatar / name / status sub-elements. Owned here at
  // the BooNode level so the captured rects persist across the
  // CardContent ↔ CircleContent unmount/remount on each shape morph.
  const avatarFlip = useRef<FlipState>(createFlipState())
  const nameFlip = useRef<FlipState>(createFlipState())
  const statusFlip = useRef<FlipState>(createFlipState())

  const glow = STATUS_GLOW[status] ?? null
  const connection = useConnection()
  const isConnecting = connection.inProgress
  const connectMode = useGraphStore((s) => s.connectMode)
  const pendingApprovals = useApprovalsStore((s) => s.pendingApprovals)
  const hasPendingApproval = Array.from(pendingApprovals.values()).some(
    (a) => a.agentId === agentId,
  )
  const agent = useFleetStore((s) => s.agents.find((a) => a.id === agentId) ?? null)
  // Event-sourced live status. Undefined when the agent has no projected board
  // activity → no pip rendered (an idle agent looks the same as ever).
  const obsStatus = useObsOverlayStore((s) => s.statusByAgent.get(agentId))
  const lastSeenAt = agent?.lastSeenAt ?? null
  const lastSeenLabel = !isRunning ? formatLastSeen(lastSeenAt) : null

  // Fine-grained activity verb. Single-value subscriptions so we only
  // re-render when THIS agent's stream or transcript ticks — subscribing to
  // the whole `transcripts` map re-rendered every Boo on every streaming
  // token of every agent, which visibly dragged the canvas during live runs.
  const sk = agent?.sessionKey ?? null
  const streamingText = useChatStore((s) => (sk ? (s.streamingText.get(sk) ?? null) : null))
  const transcript = useChatStore((s) => (sk ? (s.transcripts.get(sk) ?? null) : null))
  const activityVerb = agent
    ? getActivityVerb({
        agent,
        transcripts: sk && transcript ? new Map([[sk, transcript]]) : null,
        streamingTexts: sk ? new Map([[sk, streamingText ?? '']]) : null,
      })
    : (STATUS_LABEL[status] ?? 'idle')

  // Hover cascade — dim when another node is hovered
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(`boo-${agentId}`) ?? false),
  )

  // Degree-aware circle sizing (used only in idle shape). Increased from the
  // old 60–78 range to give Boos more visual prominence in the canvas —
  // production users reported "the boos are so small". Still well inside the
  // 280 envelope so orbital ring spacing and physics are unaffected. Boo
  // Zero (universal leader) gets a small extra boost so it visually anchors
  // the top of the team's spanning tree.
  const edgeCount = data.edgeCount ?? 0
  const baseSize = data.isUniversalLeader ? 112 : 96
  const booW = Math.min(baseSize + edgeCount * 3, data.isUniversalLeader ? 140 : 124)
  const booH = Math.round(booW * 0.92)

  const cardStatusColor = STATUS_DOT[status] ?? STATUS_DOT.idle

  // ─── Elevation + status glow ───────────────────────────────────────────────
  //
  // Both live in CSS (`.boo-cast*` in globals.css) as chained `drop-shadow`
  // filters on the mascot itself, so they trace its alpha instead of painting a
  // shape behind it. Only the colour crosses the boundary, as a custom property.
  //
  // Framer Motion was tried first and silently wrote nothing: its complex-value
  // parser declines a filter list whose colours are `rgb(var(--x) / a)` and
  // which ends in a `var()` expanding to two more functions. CSS animates it
  // natively and the global reduced-motion guard already neutralises it.
  const glowInk = glow?.color ?? null
  const glowPulse = glow?.pulse === true
  const isSleeping = status === 'sleeping'

  // Hover detection for the cascade dimming effect. We can't rely on
  // ReactFlow's `onNodeMouseEnter` here because the React Flow node element
  // has `pointer-events: none` (set in `globals.css` for `.react-flow__node-boo`)
  // — so the node element never receives mouseenter. Hover is captured on the
  // morph wrapper directly instead.
  const setHoveredNodeId = useGraphStore((s) => s.setHoveredNodeId)
  const handleMouseEnter = () => setHoveredNodeId(`boo-${agentId}`)
  const handleMouseLeave = () => setHoveredNodeId(null)

  return (
    // STATIC footprint — never transformed. React Flow measures each handle's
    // bounds ONCE, so anything that moves an ancestor of a handle desynchronises
    // the edge anchor from the visual: the Boo would bob while its edges stayed
    // put. The idle float is therefore applied to an INNER wrapper (below) that
    // holds only the visible Boo, leaving this box — and the center handles
    // anchored to its middle — perfectly still. Same split SkillNode /
    // ResourceNode use for their orbital tiles.
    <div
      style={{
        width: BOO_FOOTPRINT,
        height: BOO_FOOTPRINT,
        position: 'relative', // containing block for the static center handles
        // The empty area around the morph wrapper shouldn't intercept clicks,
        // hover, or drag events. Only the rendered Boo shape (the inner
        // motion.div) re-enables pointer events. The CSS rule on
        // `.react-flow__node-boo` in `globals.css` ensures even the React
        // Flow wrapper element doesn't catch events from the empty area.
        pointerEvents: 'none',
      }}
    >
      {/* Thought bubble — what this Boo is doing, above its right shoulder.
          A sibling of the floating layer rather than a child, so the words stay
          still while the Boo bobs. */}
      <BooThoughtBubble agentId={agentId} show={showsBubble} booW={booW} booH={booH} />

      {/* Floating layer — centers the Boo inside the footprint and carries the
          idle bob transform. Fills the footprint so the centering matches what
          the static box used to do. */}
      <div
        ref={floatRef}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <motion.div
          className="group"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          whileHover={reduceMotion ? undefined : { scale: 1.03 }}
          transition={{ scale: { type: 'spring', stiffness: 380, damping: 26 } }}
          style={{
            width: showCard ? BOO_CARD_WIDTH : booW,
            height: showCard ? BOO_CARD_HEIGHT : booH,
            position: 'relative',
            cursor: 'pointer',
            pointerEvents: 'auto',
            borderRadius: showCard ? 12 : '50%',
            background: showCard ? 'var(--card)' : 'transparent',
            // Card always uses the same subtle outline regardless of selection
            // state — the selection-thickening was visually inconsistent with
            // the now-removed circle ring and didn't add information.
            border: showCard ? '1px solid var(--border)' : 'none',
            opacity: isHighlighted ? 1 : 0.22,
            transition: SHAPE_TRANSITION,
            // 'visible' (not 'hidden') so children rendering outside the
            // immediate bounding box (e.g. circle-shape's name + status that sit
            // BELOW the avatar) aren't clipped at the rounded corner.
            overflow: 'visible',
            display: showCard ? 'flex' : 'block',
            flexDirection: showCard ? 'column' : undefined,
          }}
        >
          {/* ── Approval pulse — adapts shape via borderRadius ──────────────── */}
          {hasPendingApproval && (
            <motion.div
              animate={{
                opacity: [0.6, 1, 0.6],
                boxShadow: [
                  '0 0 0 0 rgb(var(--amber-rgb) / 0.55)',
                  '0 0 0 4px rgba(251,191,36,0)',
                  '0 0 0 0 rgb(var(--amber-rgb) / 0.55)',
                ],
              }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                position: 'absolute',
                inset: -2,
                borderRadius: showCard ? 14 : '50%',
                border: '2px solid var(--amber)',
                pointerEvents: 'none',
                zIndex: 1,
              }}
            />
          )}

          {/* Event-sourced live status pip. Only the actionable
            states render a pip; idle / no-activity shows nothing, so an idle
            agent's appearance is unchanged. */}
          {obsStatus && obsStatus !== 'idle' && (
            <div
              title={`live: ${obsStatus}`}
              style={{
                position: 'absolute',
                // Bottom LEFT, mirroring `RuntimeBadge`'s bottom-right inset.
                // It used to sit top-right, which is where the thought bubble
                // and its puffs come out — so the pip spent every run hidden
                // under them, precisely when it has something to say. The two
                // BOTTOM corners are the ones the mascot actually reaches (the
                // ghost is widest at its skirt and narrowest at its hat), so a
                // chip there reads as attached to the Boo instead of floating
                // in the empty part of its bounding box.
                // ON the mascot's lower-left flank, the way a presence dot
                // sits on an avatar — not in a corner of the bounding box. The
                // box is the square circumscribing a ghost that fills ~70% of
                // it, so every corner is empty canvas: at the old top-right
                // inset the pip read as a stray dot even before the thought
                // bubble started covering it. `RuntimeBadge` gets away with the
                // corner only by being 26px wide and overlapping back inward.
                // Percentages so it tracks the 96–140px circle range.
                top: '80%',
                left: '17%',
                transform: 'translate(-50%, -50%)',
                width: 9,
                height: 9,
                borderRadius: '50%',
                background:
                  obsStatus === 'working'
                    ? 'var(--mint)'
                    : obsStatus === 'stalled'
                      ? 'var(--amber)'
                      : 'var(--primary)',
                boxShadow: '0 0 0 2px var(--surface)',
                pointerEvents: 'none',
                zIndex: 3,
              }}
            />
          )}

          {/* Selection ring removed — the previous red ring around a clicked
            Boo had no functional purpose; the agent-detail navigation
            happens through the right-click context menu / sidebar. */}

          {/* Boo Zero needs no badge — the reserved OpenClaw-red tint plus the
            slightly larger size (see `baseSize` / `booW` above) already mark
            it as the universal team leader. The earlier crown badge was a
            third visual cue layered on top, which read as decorative noise.
            See `boo-avatar/src/index.ts` for the tint reservation. */}

          <CircleContent
            showStatusRow={!isRunning}
            glowInk={glowInk}
            glowPulse={glowPulse}
            isSleeping={isSleeping}
            agentId={agentId}
            name={name}
            selected={selected}
            status={status}
            activityVerb={activityVerb}
            booW={booW}
            booH={booH}
            cardStatusColor={cardStatusColor}
            lastSeenLabel={lastSeenLabel}
            runtime={runtime}
            ringCounts={ringCounts}
            isExpanded={isExpanded}
            avatarFlip={avatarFlip}
            nameFlip={nameFlip}
            statusFlip={statusFlip}
          />

          {/* ── The port ─────────────────────────────────────────────────────
              ONE, AND ALWAYS VISIBLE. This replaced three 8x8px handles at
              22% border opacity that only appeared on hover: the canvas could
              already author skills, shares and routes, and every one of those
              gestures started from something a first-time user could not see.
              A 20px disc carrying a + is the only advertisement the graph has
              that it can be built on.

              The TARGET handle stays where it was (top) but shares the port's
              visibility, so a thread can still be dropped ON a Boo. */}
          <Handle
            type="target"
            position={Position.Top}
            className={
              isConnecting || connectMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }
            style={isConnecting || connectMode ? handleConnecting : handleBase}
          />
          <Handle
            type="source"
            position={Position.Bottom}
            className={
              isConnecting || connectMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }
            style={isConnecting || connectMode ? handleConnecting : handleBase}
          />
          <Handle
            type="source"
            id="right"
            position={Position.Right}
            className="opacity-100"
            style={isConnecting || connectMode ? portStyleActive : portStyle}
          />
          {/* The + glyph, drawn OVER the handle and click-through so the handle
              keeps the whole 20px hit area. Purely decorative: the drag is the
              handle's. */}
          <span
            aria-hidden
            className="pointer-events-none absolute z-10 select-none font-semibold leading-none transition-colors duration-150"
            style={{
              right: -10,
              top: '50%',
              transform: 'translate(50%, -50%)',
              fontSize: 13,
              color:
                isConnecting || connectMode
                  ? 'rgb(var(--primary-rgb))'
                  : 'rgb(var(--foreground-rgb) / 0.5)',
            }}
          >
            +
          </span>
        </motion.div>
      </div>

      {/* ── Center handles — invisible, for edge path routing only ──────── */}
      {/* Anchored on the STATIC footprint (outside BOTH the floating layer
          and the morph wrapper) so edge endpoints stay glued to the node's
          geometric center: the idle bob and the circle↔card morph move the
          visual, never the edge anchor — the anchor sits safely behind the
          visible Boo shape at all times.

          See useGraphData.ts:330–336 for the handle-canonical caveat:
          'center' is SOURCE-type, 'center-target' is TARGET-type — never
          swap them when flipping edge source/target during the parent→child
          edge rewrite.

          Source uses `Position.Bottom`: in our layered DOWN org chart,
          edges depart from the leader DOWNWARD to children below. With
          `Position.Top` (the previous setup), React Flow's smooth-step
          routed the edge UP from the source first, made an elbow ABOVE
          the leader, then descended to the child — putting the
          horizontal segment way above the leader Boo instead of between
          leader and child where an org chart expects it. With Bottom +
          Top the elbow lands at the midpoint between source and target,
          the natural T-junction shape. */}
      <Handle id="center" type="source" position={Position.Bottom} style={centerHandleStyle} />
      <Handle id="center-target" type="target" position={Position.Top} style={centerHandleStyle} />
    </div>
  )
})

// ─── RingCounts ──────────────────────────────────────────────────────────────

/**
 * What this Boo carries, on its face.
 *
 * THE NODE'S ONLY ADVERTISEMENT. Every skill and connector an agent owns lives
 * in an orbital ring behind one unlabelled click, and the Boo carried no
 * chevron, badge or count -- so nothing on screen said the ring existed, and
 * every authoring gesture starts inside it.
 *
 * Silent at zero: a Boo with nothing yet should read as empty, not as three
 * zeroes. Dimmed once the ring is open, because then the tiles themselves are
 * the answer and the summary would be repeating them.
 */
function RingCounts({
  counts,
  expanded,
}: {
  counts: BooNodeData['ringCounts']
  expanded: boolean
}) {
  if (!counts) return null
  const total = counts.skills + counts.connectors + counts.routes
  if (total === 0) return null
  const parts: string[] = []
  if (counts.skills > 0) parts.push(`${counts.skills} skill${counts.skills === 1 ? '' : 's'}`)
  if (counts.connectors > 0)
    parts.push(`${counts.connectors} connector${counts.connectors === 1 ? '' : 's'}`)
  if (counts.routes > 0) parts.push(`${counts.routes} route${counts.routes === 1 ? '' : 's'}`)
  const label = parts.join(' · ')
  return (
    <span
      title={label}
      style={{
        fontSize: 10,
        letterSpacing: '0.04em',
        color: 'var(--muted-foreground)',
        opacity: expanded ? 0.4 : 0.85,
        transition: 'opacity 0.18s',
        whiteSpace: 'nowrap',
      }}
    >
      · {label}
    </span>
  )
}

// ─── CardContent ─────────────────────────────────────────────────────────────

interface ContentProps {
  agentId: string
  name: string
  selected: boolean | undefined
  status: BooNodeData['status']
  /** Fine-grained activity verb computed by the parent. */
  activityVerb: string
  cardStatusColor: string
  lastSeenLabel: string | null
  runtime: string | null
  /** What the ring holds. Rendered on the face so the node advertises its door. */
  ringCounts: BooNodeData['ringCounts']
  /** Ring already open: the counts step back rather than compete with the tiles. */
  isExpanded: boolean
  avatarFlip: MutableRefObject<FlipState>
  nameFlip: MutableRefObject<FlipState>
  statusFlip: MutableRefObject<FlipState>
}

// ─── CircleContent ───────────────────────────────────────────────────────────

interface CircleProps extends ContentProps {
  booW: number
  booH: number
  /**
   * False while the agent is running, because the thought bubble above the Boo
   * is already saying what it is doing — and saying it in more detail than a
   * one-word verb can. Leaving both up printed "Thinking..." underneath a
   * bubble that was showing the actual thought.
   */
  showStatusRow: boolean
  /** Status colour for the glow, or null when the agent has no status glow. */
  glowInk: string | null
  glowPulse: boolean
  isSleeping: boolean
}

function CircleContent({
  agentId,
  name,
  selected,
  status,
  activityVerb,
  showStatusRow,
  glowInk,
  glowPulse,
  isSleeping,
  booW,
  booH,
  cardStatusColor,
  lastSeenLabel,
  runtime,
  ringCounts,
  isExpanded,
  avatarFlip,
  nameFlip,
  statusFlip,
}: CircleProps) {
  // FLIP refs go on the INNER divs of each tracked element so the outer
  // positioning wrapper's `transform: translateX(-50%)` doesn't fight the
  // FLIP-applied transform.
  const avatarRef = useFlipMorph<HTMLDivElement>(avatarFlip)
  const nameRef = useFlipMorph<HTMLDivElement>(nameFlip)
  const statusRef = useFlipMorph<HTMLDivElement>(statusFlip)
  // Scale the badge with the degree-aware avatar, clamped so it stays a
  // legible-but-not-dominant corner chip across the 96–140px circle range.
  const badgeSize = Math.min(Math.max(18, Math.round(booW * 0.22)), 26)

  return (
    <>
      <div
        ref={avatarRef}
        // `--boo-glow` rides here and INHERITS down to the avatar. It cannot go
        // on the avatar itself: `BooAvatar` forwards `className` but not
        // `style`, and this div is a `useFlipMorph` target where a custom
        // property is inert (it changes no layout and casts no paint).
        style={
          {
            width: booW,
            height: booH,
            position: 'relative',
            ...(glowInk ? { '--boo-glow': glowInk } : null),
          } as React.CSSProperties
        }
      >
        {/* The filter lands on the mascot ALONE, via BooAvatar's className. On
            THIS div it would also catch `RuntimeBadge` — a mint-glowing runtime
            chip is immediately wrong — and a filter here would create a
            containing block and a stacking context around the badge and the
            approval ring. */}
        <AgentBooAvatar
          agentId={agentId}
          size={booW}
          className={`boo-cast${glowInk ? ' boo-cast--glow' : ''}${
            glowPulse ? ' boo-cast--pulse' : ''
          }${isSleeping ? ' boo-cast--sleeping' : ''}`}
        />
        <RuntimeBadge runtime={runtime} size={badgeSize} />
      </div>

      {/* Name — outer wrapper handles centering via flex (no transform that
          would conflict with FLIP); inner div is the FLIP target. */}
      <div
        style={{
          position: 'absolute',
          top: booH + 8,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          ref={nameRef}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: selected ? 'var(--primary)' : 'var(--foreground)',
            fontFamily: 'var(--font-display)',
            // No max-width / truncation: the name sits BELOW the avatar in
            // circle mode and has the entire 340px envelope width to
            // expand into. Long names extend symmetrically because the
            // outer flex wrapper is centered.
            whiteSpace: 'nowrap',
            letterSpacing: '0.01em',
            textAlign: 'center',
            pointerEvents: 'auto',
          }}
        >
          {name}
        </div>
      </div>

      {/* Status pill — same flex-center pattern as name. */}
      <div
        style={{
          position: 'absolute',
          top: booH + 26,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          ref={statusRef}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            pointerEvents: 'auto',
          }}
        >
          {/* Only the DOT and the VERB stand down while the bubble is up. The
              bubble is already saying what the agent is doing, in more detail
              than one word can, and printing "Thinking..." underneath it was
              the same sentence twice. */}
          {showStatusRow && (
            <>
              {status === 'running' ? (
                <motion.div
                  style={{ width: 5, height: 5, borderRadius: '50%', background: cardStatusColor }}
                  animate={{ opacity: [1, 0.2, 1] }}
                  transition={{ duration: 1.1, repeat: Infinity }}
                />
              ) : (
                <div
                  style={{ width: 5, height: 5, borderRadius: '50%', background: cardStatusColor }}
                />
              )}
              <span
                style={{ fontSize: 10, color: 'var(--muted-foreground)', letterSpacing: '0.05em' }}
                title={activityVerb}
              >
                {activityVerb}
              </span>
            </>
          )}
          {/* THE NODE'S ONLY ADVERTISEMENT of the orbital ring: without it
              nothing on screen says the ring exists, and every authoring
              gesture starts inside it. It duplicates nothing the bubble says,
              so unlike the verb it stays up for the whole run. */}
          <RingCounts counts={ringCounts} expanded={isExpanded} />
        </div>
      </div>

      {/* Last-seen — not FLIP-tracked, position-bound to circle shape only.
          Outer wrapper handles centering, no transform conflict to worry about. */}
      {lastSeenLabel && (
        <div
          style={{
            position: 'absolute',
            top: booH + 40,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              fontSize: 9,
              color: 'var(--muted-foreground)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.03em',
            }}
          >
            {lastSeenLabel}
          </div>
        </div>
      )}
    </>
  )
}
