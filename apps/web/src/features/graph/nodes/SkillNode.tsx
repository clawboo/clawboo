import { memo, useState } from 'react'
import { motion } from 'framer-motion'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import {
  BarChart3,
  Blocks,
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
import { MarkGlyph, resolveRuntimeMark } from '@/features/runtimes/RuntimeBrand'
import { AgentPickerDropdown } from '@/features/marketplace/AgentPickerDropdown'
import { installSkillForAgent } from '../operations/installSkill'
import { useGraphStore } from '../store'
import { useFloatingMotion } from '../useFloatingMotion'
import { usePeacockTransition } from '../usePeacockTransition'
import type { SkillNodeData, SkillCategory } from '../types'

// ─── Orbital tile system ──────────────────────────────────────────────────────
//
// Every orbital renders as ONE tile family (the language the Model orbital
// established): an OPAQUE accent-tinted disc (`color-mix(accent, var(--surface))`
// — never a transparent wash), a solid accent ring, a soft accent shadow, the
// glyph in full accent colour, and a theme-foreground label below. The tile
// ACCENT is TYPE-coded so the fan reads at a glance:
//
//   provider brand → the LLM model      violet → MCP connectors (ResourceNode)
//   mint           → skills / tools     slate  → the runtime built-ins rollup
//   amber          → Leadership (Boo Zero)
//
// The category picks only the GLYPH for skill tiles (variety within the mint
// family); the old per-category tile colours read as noise next to the
// type-coded connectors/model.

const CATEGORY_ICON: Record<SkillCategory, LucideIcon> = {
  data: BarChart3,
  comm: MessageSquare,
  code: Zap,
  file: FileText,
  web: Globe,
  other: Wrench,
}

// Compass picks up the "guides the team" metaphor; amber signals elevated
// status while staying clearly distinct from the type accents above.
const LEADERSHIP_VISUAL = { color: 'var(--amber)', Icon: Compass } as const

const CIRCLE = 46 // regular orbital tile diameter (px)
const MODEL_CIRCLE = 57 // the Model tile stays the biggest — the fan's anchor

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
  const {
    name,
    category,
    description,
    isVisible,
    isLeadership,
    isModel,
    isBuiltinRollup,
    installable,
    enabled,
    providerId,
    modelRuntime,
    available,
  } = data
  // Unavailable OR policy-disabled → greyed (opacity + grayscale), matching the
  // dashboard treatment. A denied tool must never read as "the agent has this".
  const greyed = available === false || enabled === false
  const floatRef = useFloatingMotion(nodeId, 'skill', dragging)
  // The model orbital tints itself by its provider brand (mono brands →
  // foreground; unknown provider → neutral) and renders the provider glyph in
  // place of a lucide icon (see the icon render below). Its `Icon` fallback is a
  // generic model glyph, used only when the provider is unknown.
  const modelBrand = isModel && providerId ? PROVIDER_BRAND[providerId] : null
  // No clawboo-known model → show the RUNTIME brand glyph instead (codex /
  // claude-code / openclaw), so the model orbital still renders + expands.
  const modelRuntimeMark =
    isModel && !providerId && modelRuntime ? resolveRuntimeMark(modelRuntime) : null
  const brandColor = modelBrand?.color ?? modelRuntimeMark?.color ?? null
  const modelColor = brandColor
    ? brandColor === 'currentColor'
      ? 'var(--foreground)'
      : brandColor
    : 'var(--category-other)'
  // TYPE-coded tile accent + glyph (see the tile-system note above). The
  // `category` still picks the glyph for skill tiles so there's variety
  // within the mint family.
  const { color, Icon } = isModel
    ? { color: modelColor, Icon: Sparkles }
    : isLeadership
      ? LEADERSHIP_VISUAL
      : isBuiltinRollup
        ? { color: 'var(--secondary)', Icon: Blocks }
        : { color: 'var(--mint)', Icon: CATEGORY_ICON[category] ?? Wrench }
  // Install is offered ONLY for a genuinely installable capability (a
  // marketplace curated skill) — observed / inherited / synthesized orbitals
  // hide the button, its picker, AND the drag-to-install handles (dragging one
  // onto a Boo would write a bogus curated-skill annotation named after it).
  const showInstall = installable === true && !isLeadership && !isModel
  const circle = isModel ? MODEL_CIRCLE : CIRCLE
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
          title={
            greyed
              ? `${description ?? name} — ${enabled === false ? 'disabled' : 'unavailable'}`
              : (description ?? name)
          }
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
          {/* The tile disc — ONE family for every orbital: an OPAQUE
              accent-tinted surface (never a transparent wash), a solid accent
              ring, and a soft accent shadow. The Model tile tints slightly
              deeper + carries a full-strength ring so it stays the anchor. */}
          <div
            style={{
              width: circle,
              height: circle,
              borderRadius: '50%',
              background: `color-mix(in srgb, ${color} ${isModel ? 24 : 15}%, var(--surface))`,
              border: isModel
                ? `1.5px solid ${color}`
                : `1.5px solid color-mix(in srgb, ${color} 65%, transparent)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: `0 2px 8px color-mix(in srgb, ${color} ${isModel ? 28 : 20}%, transparent), inset 0 1px 0 rgb(var(--foreground-rgb) / 0.07)`,
            }}
          >
            {isModel && providerId ? (
              <span style={{ color, display: 'inline-flex' }} aria-hidden>
                <ProviderGlyph id={providerId} size={33} />
              </span>
            ) : modelRuntimeMark ? (
              <span style={{ color, display: 'inline-flex' }} aria-hidden>
                <MarkGlyph glyph={modelRuntimeMark.glyph} size={30} />
              </span>
            ) : (
              <Icon size={20} strokeWidth={2} aria-hidden style={{ color, userSelect: 'none' }} />
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

          {/* Name below circle — ALWAYS theme foreground. Accent-coloured
              labels (the old treatment) were low-contrast noise on the canvas;
              the accent lives on the disc/ring/glyph, the label carries the
              information. */}
          <div
            style={{
              position: 'absolute',
              top: circle + 6,
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--foreground)',
              whiteSpace: 'nowrap',
              // Model labels ("Claude Sonnet 4.6") are longer than skill names —
              // give them more room before the ellipsis.
              maxWidth: isModel ? 124 : 104,
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
