import { memo, useState } from 'react'
import { motion } from 'framer-motion'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import {
  BarChart3,
  Compass,
  FileText,
  Globe,
  MessageSquare,
  Sparkles,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { PROVIDER_BRAND, ProviderGlyph } from '@/features/onboarding/ProviderIcon'
import { AgentPickerDropdown } from '@/features/marketplace/AgentPickerDropdown'
import { installSkillForAgent } from '../operations/installSkill'
import { useGraphStore } from '../store'
import { useFloatingMotion } from '../useFloatingMotion'
import { usePeacockTransition } from '../usePeacockTransition'
import type { SkillNodeData, SkillCategory } from '../types'

// ─── Category → colour + icon ─────────────────────────────────────────────────
//
// Emoji glyphs replaced with Lucide icons; raw hex replaced with
// the shared `--category-*` token palette (see globals.css). Both light and
// dark modes inherit through the var() chain.

const CATEGORY: Record<SkillCategory, { color: string; Icon: LucideIcon }> = {
  data: { color: 'var(--category-data)', Icon: BarChart3 },
  comm: { color: 'var(--category-comm)', Icon: MessageSquare },
  code: { color: 'var(--category-code)', Icon: Zap },
  file: { color: 'var(--category-file)', Icon: FileText },
  web: { color: 'var(--category-web)', Icon: Globe },
  other: { color: 'var(--category-other)', Icon: Wrench },
}

// Visual overrides for Boo Zero's "Leadership" orbital — see
// `SkillNodeData.isLeadership` for context. Compass icon picks up the
// "guides the team" metaphor without the crown's heraldic vibe; amber
// signals elevated status while staying clearly distinct from any of the
// regular category colors.
const LEADERSHIP_VISUAL = { color: 'var(--amber)', Icon: Compass } as const

const CIRCLE = 38 // circle diameter in px (reduced from 52 — skills feel subordinate to Boo nodes)

// ─── Handle style ─────────────────────────────────────────────────────────────

const handleStyle = {
  background: 'transparent',
  border: '1.5px solid rgb(var(--foreground-rgb) / 0.2)',
  width: 7,
  height: 7,
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

// ─── SkillNode ────────────────────────────────────────────────────────────────

export const SkillNode = memo(function SkillNode({
  id: nodeId,
  data,
  dragging,
}: NodeProps<Node<SkillNodeData, 'skill'>>) {
  const { name, category, description, isVisible, isLeadership, isModel, providerId, available } =
    data
  // Capability availability → greyed (opacity + grayscale), matching the
  // dashboard + the MCPToolsSection treatment. `undefined` = available.
  const greyed = available === false
  const floatRef = useFloatingMotion(nodeId, 'skill', dragging)
  // The model orbital tints itself by its provider brand (mono brands →
  // foreground; unknown provider → neutral) and renders the provider glyph in
  // place of a lucide icon (see the icon render below). Its `Icon` fallback is a
  // generic model glyph, used only when the provider is unknown.
  const modelBrand = isModel && providerId ? PROVIDER_BRAND[providerId] : null
  const modelColor = modelBrand
    ? modelBrand.color === 'currentColor'
      ? 'var(--foreground)'
      : modelBrand.color
    : 'var(--category-other)'
  // Leadership orbital reads its visuals from a dedicated constant — the
  // `category` field is still set on the data (defaulted to `'other'` in
  // `useGraphData`) so any downstream consumer that hasn't been taught
  // about `isLeadership` falls back gracefully.
  const { color, Icon } = isModel
    ? { color: modelColor, Icon: Sparkles }
    : isLeadership
      ? LEADERSHIP_VISUAL
      : (CATEGORY[category] ?? CATEGORY.other)
  // The Leadership + Model orbitals are not installable capabilities — hide the
  // Install button, its picker, AND the drag-to-install source handle (dragging
  // one onto a Boo would otherwise write a bogus skill named after it).
  const showInstall = !isLeadership && !isModel
  // The Model (LLM icon) orbital renders 50% larger than a regular skill so the
  // provider logo reads clearly.
  const circle = isModel ? Math.round(CIRCLE * 1.5) : CIRCLE
  const [showPicker, setShowPicker] = useState(false)

  // Hover cascade — dim when another node is hovered
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(nodeId) ?? false),
  )

  // Peacock-feather expand / collapse. When `isVisible` is undefined (e.g.
  // MiniGraph context), the hook returns a no-op identity transition so
  // the node renders normally with no animation.
  const peacock = usePeacockTransition(nodeId, isVisible)

  return (
    <motion.div
      initial={peacock.initial}
      animate={peacock.animate}
      transition={peacock.transition}
      style={{
        // Pin the transform origin to the visual center so `scale: 0`
        // collapses INTO the node's center (which lives behind the parent
        // Boo via the orbital placement), producing the "bursting from
        // behind" peacock feel without hand-computing per-node offsets.
        transformOrigin: 'center center',
        pointerEvents: peacock.pointerEvents,
      }}
    >
      <div ref={floatRef}>
        <div
          title={greyed ? `${description ?? name} — unavailable` : (description ?? name)}
          className="group"
          style={{
            width: circle,
            height: circle,
            position: 'relative',
            overflow: 'visible',
            opacity: greyed ? (isHighlighted ? 0.5 : 0.16) : isHighlighted ? 1 : 0.22,
            filter: greyed ? 'grayscale(1)' : undefined,
            transition: 'opacity 0.2s ease, filter 0.2s ease',
          }}
        >
          {/* Filled circle. Skills/Leadership use a faint tint; the Model
              orbital renders like a REAL provider logo tile — an OPAQUE
              brand-tinted disc (surface-based so it isn't transparent) with a
              solid brand-coloured ring and the brand glyph in its true colour. */}
          <div
            style={{
              width: circle,
              height: circle,
              borderRadius: '50%',
              background: isModel
                ? `color-mix(in srgb, ${color} 24%, var(--surface))`
                : `color-mix(in srgb, ${color} 9%, transparent)`,
              border: isModel
                ? `1.5px solid ${color}`
                : `2px solid color-mix(in srgb, ${color} 33%, transparent)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: isModel
                ? `0 2px 8px color-mix(in srgb, ${color} 28%, transparent), inset 0 1px 0 rgb(var(--foreground-rgb) / 0.08)`
                : `0 0 14px color-mix(in srgb, ${color} 16%, transparent), inset 0 1px 0 rgb(var(--foreground-rgb) / 0.06)`,
            }}
          >
            {isModel && providerId ? (
              <span style={{ color, display: 'inline-flex' }} aria-hidden>
                <ProviderGlyph id={providerId} size={33} />
              </span>
            ) : (
              <Icon size={16} strokeWidth={1.75} aria-hidden style={{ color, userSelect: 'none' }} />
            )}
          </div>

          {/* Install button — appears on hover. Hidden for the Leadership +
              Model orbitals: they're not installable capabilities. Suppressing
              the button removes the action AND avoids opening a no-op
              picker dropdown. */}
          {showInstall && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setShowPicker((v) => !v)
              }}
              className="font-mono uppercase opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
              style={{
                position: 'absolute',
                top: -6,
                right: -14,
                background: 'var(--mint)',
                color: 'var(--background)',
                border: 'none',
                borderRadius: 5,
                fontSize: 10,
                fontWeight: 600,
                padding: '2px 6px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                letterSpacing: '0.06em',
              }}
            >
              Install →
            </button>
          )}

          {/* Agent picker dropdown — same suppression rule as the button. */}
          {showInstall && showPicker && (
            <AgentPickerDropdown
              onSelect={(agentId, agentName) => {
                void installSkillForAgent(name, agentId, agentName)
              }}
              onClose={() => setShowPicker(false)}
              style={{ top: circle + 4, left: '50%', transform: 'translateX(-50%)' }}
            />
          )}

          {/* Name below circle */}
          <div
            style={{
              position: 'absolute',
              top: circle + 6,
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: 11,
              fontWeight: 500,
              // The model label is free-standing text on the canvas — use the
              // theme foreground (not the raw brand hex, which is low-contrast
              // for pale accents like OpenRouter/HuggingFace on the light
              // canvas). The brand colour stays on the disc bg/border/glyph.
              color: isModel ? 'var(--foreground)' : color,
              whiteSpace: 'nowrap',
              // Model labels ("Claude Sonnet 4.6") are longer than skill names —
              // give them more room before the ellipsis.
              maxWidth: isModel ? 124 : 84,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textAlign: 'center',
              letterSpacing: '0.02em',
            }}
          >
            {name}
          </div>

          {/* Left handle — target for incoming edges from BooNodes. Hidden for
              the non-installable Leadership + Model orbitals. */}
          {showInstall && (
            <Handle
              type="target"
              position={Position.Left}
              style={{
                ...handleStyle,
                borderColor: `color-mix(in srgb, ${color} 33%, transparent)`,
              }}
            />
          )}
          {/* Right handle — source for drag-to-install onto BooNodes. Hidden for
              Leadership + Model: dragging one onto a Boo would install a bogus
              skill named after it. */}
          {showInstall && (
            <Handle
              type="source"
              id="install"
              position={Position.Right}
              style={{
                ...handleStyle,
                borderColor: `color-mix(in srgb, ${color} 33%, transparent)`,
              }}
            />
          )}

          {/* Center handle — invisible, for edge path routing only */}
          <Handle id="center" type="target" position={Position.Left} style={centerHandleStyle} />
        </div>
      </div>
    </motion.div>
  )
})
