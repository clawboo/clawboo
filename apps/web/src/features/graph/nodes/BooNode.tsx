'use client'

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { motion } from 'framer-motion'
import { BooAvatar } from '@clawboo/ui'
import type { BooNodeData } from '../types'
import { useApprovalsStore } from '@/stores/approvals'

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

// ─── Handle style ─────────────────────────────────────────────────────────────

const handleStyle = {
  background: 'transparent',
  border: '1.5px solid rgba(255,255,255,0.22)',
  width: 8,
  height: 8,
}

// ─── BooNode dimensions ───────────────────────────────────────────────────────
// BooAvatar viewBox is 100×92 → aspect = 0.92
// At BOO_W=60: BOO_H = round(60 × 0.92) = 55

const BOO_W = 60
const BOO_H = Math.round(BOO_W * 0.92) // 55

// ─── BooNode ──────────────────────────────────────────────────────────────────

export const BooNode = memo(function BooNode({
  data,
  selected,
}: NodeProps<Node<BooNodeData, 'boo'>>) {
  const { agentId, name, status } = data
  const glow = STATUS_GLOW[status] ?? null
  const pendingApprovals = useApprovalsStore((s) => s.pendingApprovals)
  const hasPendingApproval = Array.from(pendingApprovals.values()).some(
    (a) => a.agentId === agentId,
  )

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
    // Node root: exactly BOO_W × BOO_H.
    // overflow: visible lets the name + status label render below
    // without inflating the React Flow measured size.
    <div
      style={{
        width: BOO_W,
        height: BOO_H,
        position: 'relative',
        overflow: 'visible',
        cursor: 'pointer',
      }}
    >
      {/* ── BooAvatar + glow ──────────────────────────────────────────────── */}
      <motion.div
        style={{ width: BOO_W, height: BOO_H, position: 'relative' }}
        animate={{ filter: dropShadow }}
        transition={
          glow?.pulse ? { duration: 2.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 }
        }
      >
        <BooAvatar seed={agentId} size={BOO_W} />
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
          top: BOO_H + 8,
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
          top: BOO_H + 26,
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

      {/* ── Handles ──────────────────────────────────────────────────────── */}
      {/* Top: center of ghost head */}
      <Handle type="target" position={Position.Top} style={handleStyle} />
      {/* Bottom: between ghost bumps */}
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      {/* Right: ghost body mid-height */}
      <Handle type="source" id="right" position={Position.Right} style={handleStyle} />
    </div>
  )
})
