import { memo, useRef, type MutableRefObject } from 'react'
import { Handle, Position, useConnection } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { motion } from 'framer-motion'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import type { BooNodeData } from '../types'
import { useGraphStore } from '../store'
import { useFloatingMotion } from '../useFloatingMotion'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { BooLiveActivity } from './BooLiveActivity'
import { createFlipState, useFlipMorph, type FlipState } from './useFlipMorph'

// ─── BooNode — dual-shape: idle = circle, active = card ──────────────────────
//
// Two visual modes share one component:
//
//   Idle   (status !== 'running')
//          ┌────┐
//          │ ◯  │   ← degree-aware circle (60–78px), avatar fills the disc
//          └────┘
//             Name           ← absolute below
//             ● status       ← absolute below name
//             seen 2m ago    ← absolute below status (only when not running)
//
//   Active (status === 'running')
//          ┌──────────────────────────────────┐
//          │ [avatar] Name        ● running   │  HEADER  (44px)
//          ├──────────────────────────────────┤
//          │  [live activity feed — 2 lines]  │  MIDDLE  (52px)
//          ├──────────────────────────────────┤
//          │                                  │  FOOTER  (24px, reserved)
//          └──────────────────────────────────┘
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
// The card's middle band renders <BooLiveActivity> — the latest assistant
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

const STATUS_GLOW: Record<string, GlowConfig | null> = {
  idle: null,
  running: { color: 'rgba(52,211,153,0.55)', pulse: true },
  error: { color: 'rgba(249,115,22,0.55)', pulse: false },
  sleeping: { color: 'rgba(96,115,140,0.30)', pulse: false },
}

const STATUS_DOT: Record<string, string> = {
  idle: '#4B5563',
  running: '#34D399',
  error: '#F97316',
  sleeping: '#FBBF24',
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
  border: '1.5px solid rgba(255,255,255,0.22)',
  width: 8,
  height: 8,
  transition: 'opacity 0.15s, background 0.15s, width 0.15s, height 0.15s',
}

const handleConnecting: React.CSSProperties = {
  background: 'rgba(233,69,96,0.5)',
  border: '1px solid rgba(233,69,96,0.3)',
  width: 12,
  height: 12,
  borderRadius: '50%',
  transition: 'opacity 0.15s, background 0.15s, width 0.15s, height 0.15s',
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

// CSS transition for the wrapper size + border-radius morph.
const SHAPE_TRANSITION =
  'width 0.28s cubic-bezier(0.4, 0, 0.2, 1), ' +
  'height 0.28s cubic-bezier(0.4, 0, 0.2, 1), ' +
  'border-radius 0.28s cubic-bezier(0.4, 0, 0.2, 1), ' +
  'background 0.2s ease, ' +
  'border-color 0.15s ease, ' +
  'opacity 0.2s ease'

// ─── BooNode ─────────────────────────────────────────────────────────────────

export const BooNode = memo(function BooNode({
  data,
  selected,
  dragging,
}: NodeProps<Node<BooNodeData, 'boo'>>) {
  const { agentId, name, status } = data
  const floatRef = useFloatingMotion(agentId, 'boo', dragging)
  const showCard = status === 'running'

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
  const lastSeenAt = useFleetStore(
    (s) => s.agents.find((a) => a.id === agentId)?.lastSeenAt ?? null,
  )
  const lastSeenLabel = !showCard ? formatLastSeen(lastSeenAt) : null

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

  // Box-shadow animation driven by status (glow at the wrapper edge, works
  // for both circular and rounded-rect shapes via border-radius inheritance).
  const boxShadow = glow
    ? glow.pulse
      ? [
          `0 0 0 0 ${glow.color}, 0 4px 12px rgba(0,0,0,0.4)`,
          `0 0 0 6px rgba(52,211,153,0), 0 4px 16px rgba(0,0,0,0.5)`,
          `0 0 0 0 ${glow.color}, 0 4px 12px rgba(0,0,0,0.4)`,
        ]
      : `0 0 0 1.5px ${glow.color}, 0 4px 12px rgba(0,0,0,0.4)`
    : showCard
      ? '0 4px 12px rgba(0,0,0,0.4)'
      : '0 0 0 0 rgba(0,0,0,0)'

  const cardStatusColor = STATUS_DOT[status] ?? STATUS_DOT.idle

  // Hover detection for the cascade dimming effect. We can't rely on
  // ReactFlow's `onNodeMouseEnter` here because the React Flow node element
  // has `pointer-events: none` (set in `globals.css` for `.react-flow__node-boo`)
  // — so the node element never receives mouseenter. Hover is captured on the
  // morph wrapper directly instead.
  const setHoveredNodeId = useGraphStore((s) => s.setHoveredNodeId)
  const handleMouseEnter = () => setHoveredNodeId(`boo-${agentId}`)
  const handleMouseLeave = () => setHoveredNodeId(null)

  return (
    <div
      ref={floatRef}
      style={{
        width: BOO_FOOTPRINT,
        height: BOO_FOOTPRINT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // The empty area around the morph wrapper shouldn't intercept clicks,
        // hover, or drag events. Only the rendered Boo shape (the inner
        // motion.div) re-enables pointer events. The CSS rule on
        // `.react-flow__node-boo` in `globals.css` ensures even the React
        // Flow wrapper element doesn't catch events from the empty area.
        pointerEvents: 'none',
      }}
    >
      <motion.div
        className="group"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        animate={{ boxShadow }}
        transition={
          glow?.pulse ? { duration: 2.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 }
        }
        style={{
          width: showCard ? BOO_CARD_WIDTH : booW,
          height: showCard ? BOO_CARD_HEIGHT : booH,
          position: 'relative',
          cursor: 'pointer',
          pointerEvents: 'auto',
          borderRadius: showCard ? 12 : '50%',
          background: showCard ? '#111827' : 'transparent',
          // Card always uses the same subtle outline regardless of selection
          // state — the selection-thickening was visually inconsistent with
          // the now-removed circle ring and didn't add information.
          border: showCard ? '1px solid rgba(255,255,255,0.08)' : 'none',
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
                '0 0 0 0 rgba(251,191,36,0.55)',
                '0 0 0 4px rgba(251,191,36,0)',
                '0 0 0 0 rgba(251,191,36,0.55)',
              ],
            }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              position: 'absolute',
              inset: -2,
              borderRadius: showCard ? 14 : '50%',
              border: '2px solid #FBBF24',
              pointerEvents: 'none',
              zIndex: 1,
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

        {showCard ? (
          <CardContent
            agentId={agentId}
            name={name}
            selected={selected}
            status={status}
            cardStatusColor={cardStatusColor}
            lastSeenLabel={lastSeenLabel}
            avatarFlip={avatarFlip}
            nameFlip={nameFlip}
            statusFlip={statusFlip}
          />
        ) : (
          <CircleContent
            agentId={agentId}
            name={name}
            selected={selected}
            status={status}
            booW={booW}
            booH={booH}
            cardStatusColor={cardStatusColor}
            lastSeenLabel={lastSeenLabel}
            avatarFlip={avatarFlip}
            nameFlip={nameFlip}
            statusFlip={statusFlip}
          />
        )}

        {/* ── Interactive handles (visible on hover / connect) ────────────── */}
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
          className={
            isConnecting || connectMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }
          style={isConnecting || connectMode ? handleConnecting : handleBase}
        />

        {/* ── Center handles — invisible, for edge path routing only ──────── */}
        {/* See useGraphData.ts:330–336 for the handle-canonical caveat:
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
        <Handle
          id="center-target"
          type="target"
          position={Position.Top}
          style={centerHandleStyle}
        />
      </motion.div>
    </div>
  )
})

// ─── CardContent ─────────────────────────────────────────────────────────────

interface ContentProps {
  agentId: string
  name: string
  selected: boolean | undefined
  status: BooNodeData['status']
  cardStatusColor: string
  lastSeenLabel: string | null
  avatarFlip: MutableRefObject<FlipState>
  nameFlip: MutableRefObject<FlipState>
  statusFlip: MutableRefObject<FlipState>
}

function CardContent({
  agentId,
  name,
  selected,
  status,
  cardStatusColor,
  lastSeenLabel,
  avatarFlip,
  nameFlip,
  statusFlip,
}: ContentProps) {
  const avatarRef = useFlipMorph<HTMLDivElement>(avatarFlip)
  const nameRef = useFlipMorph<HTMLDivElement>(nameFlip)
  const statusRef = useFlipMorph<HTMLDivElement>(statusFlip)

  return (
    <>
      {/* HEADER */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}
      >
        <div ref={avatarRef} style={{ flexShrink: 0, width: 44, height: 44, position: 'relative' }}>
          <AgentBooAvatar agentId={agentId} size={44} />
        </div>
        <div ref={nameRef} style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: selected ? '#E94560' : '#E8E8E8',
              fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              letterSpacing: '0.01em',
              lineHeight: 1.2,
            }}
            title={name}
          >
            {name}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'rgba(232,232,232,0.45)',
              marginTop: 3,
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {STATUS_LABEL[status] ?? 'idle'}
            {lastSeenLabel ? ` · seen ${lastSeenLabel}` : ''}
          </div>
        </div>
        <div ref={statusRef} style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {status === 'running' ? (
            <motion.div
              style={{ width: 10, height: 10, borderRadius: '50%', background: cardStatusColor }}
              animate={{ opacity: [1, 0.25, 1] }}
              transition={{ duration: 1.1, repeat: Infinity }}
            />
          ) : (
            <div
              style={{ width: 10, height: 10, borderRadius: '50%', background: cardStatusColor }}
            />
          )}
        </div>
      </div>

      {/* MIDDLE — live activity feed */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          padding: '8px 14px',
          position: 'relative',
          background:
            'radial-gradient(circle at center, rgba(52,211,153,0.04) 0%, transparent 60%)',
          overflow: 'hidden',
        }}
      >
        <BooLiveActivity agentId={agentId} />
      </div>

      {/* FOOTER — reserved real estate (per-Boo metric slot, future) */}
      <div
        style={{
          padding: '6px 12px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          fontSize: 10,
          color: 'rgba(232,232,232,0.4)',
          flexShrink: 0,
          minHeight: 24,
        }}
      />
    </>
  )
}

// ─── CircleContent ───────────────────────────────────────────────────────────

interface CircleProps extends ContentProps {
  booW: number
  booH: number
}

function CircleContent({
  agentId,
  name,
  selected,
  status,
  booW,
  booH,
  cardStatusColor,
  lastSeenLabel,
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

  return (
    <>
      <div ref={avatarRef} style={{ width: booW, height: booH, position: 'relative' }}>
        <AgentBooAvatar agentId={agentId} size={booW} />
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
            color: selected ? '#E94560' : '#E8E8E8',
            fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
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
          <span style={{ fontSize: 10, color: 'rgba(232,232,232,0.38)', letterSpacing: '0.05em' }}>
            {STATUS_LABEL[status] ?? 'idle'}
          </span>
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
              color: 'rgba(232,232,232,0.25)',
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
