'use client'

import { memo } from 'react'
import { Handle, Position, useConnection } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { motion } from 'framer-motion'
import { BooAvatar } from '@clawboo/ui'
import type { BooNodeData } from '../types'
import { useGraphStore } from '../store'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLastSeen(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) return null
  const diff = Date.now() - lastSeenAt
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ─── Status → glow config ─────────────────────────────────────────────────────

type GlowConfig = { color: string; pulse: boolean }

const STATUS_GLOW: Record<string, GlowConfig | null> = {
  idle: null,
  running: { color: 'rgba(52,211,153,0.75)', pulse: true },
  error: { color: 'rgba(249,115,22,0.65)', pulse: false },
  sleeping: { color: 'rgba(96,115,140,0.35)', pulse: false },
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
// NOTE: opacity is controlled via Tailwind classes, NOT inline style.
// Inline `opacity: 0` would override `group-hover:opacity-100` since inline > class.

const handleBase = {
  background: 'transparent',
  border: '1.5px solid rgba(255,255,255,0.22)',
  width: 8,
  height: 8,
  transition: 'opacity 0.15s, background 0.15s, width 0.15s, height 0.15s',
}

const handleConnecting = {
  background: 'rgba(233,69,96,0.5)',
  border: '1px solid rgba(233,69,96,0.3)',
  width: 12,
  height: 12,
  borderRadius: '50%',
  transition: 'opacity 0.15s, background 0.15s, width 0.15s, height 0.15s',
}

// Invisible center handle style — used for edge path routing only
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
}: NodeProps<Node<BooNodeData, 'boo'>>) {
  const { agentId, name, status } = data
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

  // Degree-aware sizing: +3px per connected edge, capped at +18px
  const edgeCount = data.edgeCount ?? 0
  const booW = Math.min(60 + edgeCount * 3, 78)
  const booH = Math.round(booW * 0.92)

  // Drop-shadow animation driven by status
  const dropShadow = glow
    ? glow.pulse
      ? [
          `drop-shadow(0 0 0px ${glow.color})`,
          `drop-shadow(0 0 16px ${glow.color})`,
          `drop-shadow(0 0 0px ${glow.color})`,
        ]
      : `drop-shadow(0 0 6px ${glow.color})`
    : 'drop-shadow(0 0 0px rgba(0,0,0,0))'

  return (
    <div
      className="group"
      style={{
        width: booW,
        height: booH,
        position: 'relative',
        overflow: 'visible',
        cursor: 'pointer',
        opacity: isHighlighted ? 1 : 0.22,
        transition: 'opacity 0.2s ease',
      }}
    >
      {/* ── BooAvatar + glow ──────────────────────────────────────────────── */}
      <motion.div
        style={{ width: booW, height: booH, position: 'relative' }}
        animate={{ filter: dropShadow }}
        transition={
          glow?.pulse ? { duration: 2.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 }
        }
      >
        <BooAvatar seed={agentId} size={booW} />
      </motion.div>

      {/* ── Approval alert ring (pulsing amber) ───────────────────────────── */}
      {hasPendingApproval && (
        <motion.div
          animate={{ scale: [1, 1.15, 1], opacity: [0.8, 1, 0.8] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            inset: -5,
            borderRadius: 10,
            border: '2.5px solid #FBBF24',
            boxShadow: '0 0 12px rgba(251,191,36,0.55)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* ── Selection ring ────────────────────────────────────────────────── */}
      {selected && (
        <div
          style={{
            position: 'absolute',
            inset: -3,
            borderRadius: 8,
            border: '2px solid rgba(233,69,96,0.7)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* ── Name label ───────────────────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          top: booH + 8,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 12,
          fontWeight: 600,
          color: selected ? '#E94560' : '#E8E8E8',
          fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
          whiteSpace: 'nowrap',
          maxWidth: 96,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textAlign: 'center',
          letterSpacing: '0.01em',
        }}
      >
        {name}
      </div>

      {/* ── Status dot + label ────────────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          top: booH + 26,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {status === 'running' ? (
          <motion.div
            style={{ width: 5, height: 5, borderRadius: '50%', background: STATUS_DOT.running }}
            animate={{ opacity: [1, 0.2, 1] }}
            transition={{ duration: 1.1, repeat: Infinity }}
          />
        ) : (
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: STATUS_DOT[status] ?? STATUS_DOT.idle,
            }}
          />
        )}
        <span
          style={{
            fontSize: 10,
            color: 'rgba(232,232,232,0.38)',
            letterSpacing: '0.05em',
          }}
        >
          {STATUS_LABEL[status] ?? 'idle'}
        </span>
      </div>

      {/* ── Last seen label ────────────────────────────────────────────── */}
      {lastSeenLabel && (
        <div
          style={{
            position: 'absolute',
            top: booH + 40,
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: 9,
            color: 'rgba(232,232,232,0.25)',
            whiteSpace: 'nowrap',
            letterSpacing: '0.03em',
          }}
        >
          {lastSeenLabel}
        </div>
      )}

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
      <Handle id="center-target" type="target" position={Position.Top} style={centerHandleStyle} />
    </div>
  )
})
