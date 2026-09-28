import { memo, useEffect } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useUpdateNodeInternals } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import {
  BarChart3,
  FileText,
  Globe,
  MessageSquare,
  Plug,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'

import { brandColorVar, ConnectorGlyph, hasBrandMark } from '@/features/connectors/ConnectorMark'

import { LOOSE_TILE, looseScale, useLooseNodeStore, type LooseNodeData } from '../looseNodes'
import { useGraphStore } from '../store'
import { useZoomStep } from '../useMinScreenSize'
import type { SkillCategory } from '../types'
import { BooPort } from './BooPort'

// ─── A loose node ────────────────────────────────────────────────────────────
//
// A skill or connector put on the canvas with the + button, given to no agent
// yet. It reads as one of the orbital tiles (same disc, same type colours) with
// one difference that carries the meaning: a DASHED ring, the same language the
// docking rings use for "not attached yet". Its port is a Boo's port, shown on
// hover like one; a thread from it onto a Boo gives that agent the thing, and
// this node goes. See looseNodes.ts.
//
// IT KEEPS A SIZE YOU CAN FIND. Atlas usually sits between 0.25 and 0.35 zoom,
// where a 46-unit tile is an 11px speck: too small to spot where it landed, let
// alone to grab. So the tile draws at no less than `LOOSE_MIN_SCREEN` on screen
// (see looseNodes.ts), grown around its centre. React Flow's box stays 46; the
// port moves out with the drawing, so its handle is re-measured whenever the
// scale changes, or a thread would start from where the port used to be.

const CATEGORY_ICON: Record<SkillCategory, LucideIcon> = {
  data: BarChart3,
  comm: MessageSquare,
  code: Zap,
  file: FileText,
  web: Globe,
  other: Wrench,
}

export const LooseNode = memo(function LooseNode({
  id,
  data,
  isConnectable,
}: NodeProps<Node<LooseNodeData, 'loose'>>) {
  const { kind, name, description, slug, category, accent, canvasKey } = data
  const reduceMotion = useReducedMotion()
  const k = looseScale(useZoomStep())
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, k, updateNodeInternals])
  // The hover cascade dims everything outside the hovered cluster. A loose node
  // belongs to no cluster, so it dims whenever something else is hovered.
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(id) ?? false),
  )

  const brandSlug = slug && hasBrandMark(slug) ? slug : null
  const Icon = kind === 'skill' ? (CATEGORY_ICON[category ?? 'other'] ?? Wrench) : Plug

  return (
    <div
      className="group"
      style={{
        width: LOOSE_TILE,
        height: LOOSE_TILE,
        position: 'relative',
        overflow: 'visible',
        opacity: isHighlighted ? 1 : 0.22,
        transition: 'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {/* Everything but the port, at the floored size, around the box's centre. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: k === 1 ? undefined : `scale(${k})`,
          transformOrigin: '50% 50%',
        }}
      >
        {/* THE DISC ANIMATES, THE PORT DOES NOT. React Flow measures a handle's
          bounds once, through every transform above it, so a port inside a
          growing wrapper would be registered where the pop-in started. The
          disc is the port's sibling, never its ancestor. */}
        <motion.div
          title={description ?? name}
          initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          whileHover={reduceMotion ? undefined : { scale: 1.06 }}
          transition={{ type: 'spring', stiffness: 420, damping: 24 }}
          style={{
            width: LOOSE_TILE,
            height: LOOSE_TILE,
            borderRadius: '50%',
            background: `color-mix(in srgb, ${accent} 12%, var(--surface))`,
            border: `1.5px dashed color-mix(in srgb, ${accent} 75%, transparent)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 2px 8px color-mix(in srgb, ${accent} 18%, transparent)`,
          }}
        >
          {brandSlug ? (
            <span style={{ display: 'flex', color: brandColorVar(brandSlug) }}>
              <ConnectorGlyph slug={brandSlug} title={name} size={20} />
            </span>
          ) : (
            <Icon size={20} strokeWidth={2} aria-hidden style={{ color: accent }} />
          )}
        </motion.div>

        {/* Take it back off the canvas. On hover, like the port, and a real
          button, so it is reachable from the keyboard too. `nodrag` so pressing
          it never starts moving the node. */}
        <button
          type="button"
          aria-label={`Remove ${name} from the canvas`}
          title="Remove from the canvas"
          onClick={(e) => {
            e.stopPropagation()
            useLooseNodeStore.getState().remove(canvasKey, id)
          }}
          className="nodrag nopan absolute flex size-[18px] cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-muted-foreground opacity-0 shadow-[var(--shadow-raised)] transition-opacity duration-150 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          style={{ top: -5, left: -5 }}
        >
          <X size={11} strokeWidth={2.5} aria-hidden />
        </button>

        <div
          style={{
            position: 'absolute',
            top: LOOSE_TILE + 6,
            left: '50%',
            transform: 'translateX(-50%)',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--foreground)',
              letterSpacing: '0.02em',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {name}
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted-foreground)', marginTop: 1 }}>
            Not attached
          </div>
        </div>
      </div>

      {/* Outside the scaled drawing, placed at its edge. */}
      <BooPort
        booW={(LOOSE_TILE / 2) * (1 + k)}
        isConnectable={isConnectable}
        label="Drag onto an agent"
      />
    </div>
  )
})
