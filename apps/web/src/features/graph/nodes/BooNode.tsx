import { memo } from 'react'
import { Handle, Position, useConnection } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { motion } from 'framer-motion'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import type { BooNodeData } from '../types'
import { useGraphStore } from '../store'
import { useFloatingMotion } from '../useFloatingMotion'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'

// ─── BooNode — card-shaped agent surface ─────────────────────────────────────
//
// Replaces the previous circle-with-text layout. The card is 220×120 and is
// composed of three horizontal sections separated by subtle dividers:
//
//   ┌────────────────────────────────────────────┐
//   │ [avatar 36] Name                ● status   │  HEADER   (44px)
//   ├────────────────────────────────────────────┤
//   │                                            │
//   │      <live preview placeholder>            │  MIDDLE   (52px)
//   │                                            │
//   ├────────────────────────────────────────────┤
//   │ [team]  Dev Team           seen 2m ago     │  FOOTER   (24px)
//   └────────────────────────────────────────────┘
//
// The MIDDLE band is reserved real estate for the future "live preview"
// feature (e.g. a tiny browser thumbnail, terminal tail, or call timeline
// streamed from the agent). For now it shows a subtle status hint.
//
// Card-shaped nodes pair well with the layered DOWN ELK layout — flat
// rectangles tile cleanly into rows, edges enter the top and exit the
// bottom in predictable lanes, no orbital re-flow needed.

// ─── Card dimensions (kept in sync with computeElkLayout) ─────────────────────

export const BOO_CARD_WIDTH = 220
export const BOO_CARD_HEIGHT = 120

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLastSeen(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) return null
  const diff = Date.now() - lastSeenAt
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ─── Status → glow / dot / label ──────────────────────────────────────────────

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

// ─── Handle styles ────────────────────────────────────────────────────────────

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

// ─── BooNode ──────────────────────────────────────────────────────────────────

export const BooNode = memo(function BooNode({
  data,
  selected,
  dragging,
}: NodeProps<Node<BooNodeData, 'boo'>>) {
  const { agentId, name, status, teamId, teamName, teamColor, teamEmoji } = data
  const floatRef = useFloatingMotion(agentId, 'boo', dragging)
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
  const lastSeenLabel = status !== 'running' ? formatLastSeen(lastSeenAt) : null

  // Hover cascade — dim when another node is hovered
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(`boo-${agentId}`) ?? false),
  )

  // Box-shadow animation driven by status (glow-on-card-edge).
  const boxShadow = glow
    ? glow.pulse
      ? [
          `0 0 0 0 ${glow.color}, 0 4px 12px rgba(0,0,0,0.4)`,
          `0 0 0 6px rgba(52,211,153,0), 0 4px 16px rgba(0,0,0,0.5)`,
          `0 0 0 0 ${glow.color}, 0 4px 12px rgba(0,0,0,0.4)`,
        ]
      : `0 0 0 1.5px ${glow.color}, 0 4px 12px rgba(0,0,0,0.4)`
    : '0 4px 12px rgba(0,0,0,0.4)'

  const cardStatusColor = STATUS_DOT[status] ?? STATUS_DOT.idle

  return (
    <div ref={floatRef}>
      <motion.div
        className="group"
        animate={{ boxShadow }}
        transition={
          glow?.pulse ? { duration: 2.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 }
        }
        style={{
          width: BOO_CARD_WIDTH,
          height: BOO_CARD_HEIGHT,
          position: 'relative',
          cursor: 'pointer',
          borderRadius: 12,
          background: '#111827',
          border: selected ? '2px solid rgba(233,69,96,0.7)' : '1px solid rgba(255,255,255,0.08)',
          opacity: isHighlighted ? 1 : 0.22,
          transition: 'opacity 0.2s ease, border-color 0.15s ease',
          overflow: 'hidden', // keep dividers crisp at the rounded corners
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ── Approval pulse (around the whole card) ──────────────────────── */}
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
              borderRadius: 14,
              border: '2px solid #FBBF24',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        )}

        {/* ── HEADER: avatar + name + status dot ─────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}
        >
          <div style={{ flexShrink: 0, width: 36, height: 36, position: 'relative' }}>
            <AgentBooAvatar agentId={agentId} size={36} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
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
                fontSize: 10,
                color: 'rgba(232,232,232,0.45)',
                marginTop: 2,
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
          {status === 'running' ? (
            <motion.div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: cardStatusColor,
                flexShrink: 0,
              }}
              animate={{ opacity: [1, 0.25, 1] }}
              transition={{ duration: 1.1, repeat: Infinity }}
            />
          ) : (
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: cardStatusColor,
                flexShrink: 0,
              }}
            />
          )}
        </div>

        {/* ── MIDDLE: live-preview slot (placeholder) ────────────────────── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '6px 12px',
            color: 'rgba(232,232,232,0.32)',
            fontSize: 11,
            fontStyle: 'italic',
            letterSpacing: '0.02em',
            textAlign: 'center',
            position: 'relative',
            // Subtle "ready for content" gradient wash so the empty band
            // doesn't look like a bug. Fades to nothing when live preview
            // content lands here in a future iteration.
            background:
              'radial-gradient(circle at center, rgba(52,211,153,0.04) 0%, transparent 60%)',
          }}
        >
          {/* Future home of: browser screenshot, terminal tail, video frame,
              call timeline, etc. For now: a calm hint at status. */}
          {status === 'running' ? (
            <span style={{ color: 'rgba(52,211,153,0.55)', fontStyle: 'normal' }}>working…</span>
          ) : status === 'error' ? (
            <span style={{ color: 'rgba(249,115,22,0.65)', fontStyle: 'normal' }}>
              encountered an error
            </span>
          ) : (
            <span>ready</span>
          )}
        </div>

        {/* ── FOOTER: team badge + last seen ─────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            padding: '6px 12px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            fontSize: 10,
            color: 'rgba(232,232,232,0.4)',
            flexShrink: 0,
          }}
        >
          {teamId ? (
            <span
              title={teamName ?? 'Team'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                borderRadius: 8,
                background: `${teamColor ?? '#34D399'}1A`,
                border: `1px solid ${teamColor ?? 'rgba(255,255,255,0.15)'}`,
                color: '#E8E8E8',
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: '0.03em',
                whiteSpace: 'nowrap',
                maxWidth: 110,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {teamEmoji && <span style={{ fontSize: 10 }}>{teamEmoji}</span>}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {teamName ?? 'Team'}
              </span>
            </span>
          ) : (
            <span />
          )}
          {/* Right slot: future per-Boo metric (tokens, cost, calls). */}
          <span style={{ whiteSpace: 'nowrap', letterSpacing: '0.04em' }}>
            {/* Empty for now — placeholder so the footer is balanced. */}
          </span>
        </div>

        {/* ── Interactive handles ─────────────────────────────────────────── */}
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
        <Handle id="center" type="source" position={Position.Top} style={centerHandleStyle} />
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
