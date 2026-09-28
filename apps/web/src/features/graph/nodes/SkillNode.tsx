import { memo, useCallback, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Handle, NodeToolbar, Position, useStore } from '@xyflow/react'
import type { NodeProps, Node, ReactFlowState } from '@xyflow/react'
import {
  BarChart3,
  Blocks,
  Cable,
  Compass,
  FileText,
  Globe,
  MessageSquare,
  Puzzle,
  Sparkles,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { PROVIDER_BRAND, ProviderGlyph, type ProviderId } from '@/features/onboarding/ProviderIcon'
import { MarkGlyph, resolveRuntimeMark, runtimeLabel } from '@/features/runtimes/RuntimeBrand'
import { AgentPickerDropdown } from '@/features/marketplace/AgentPickerDropdown'
import type { CapabilityClass } from '../capabilityVocabulary'
import { installSkillForAgent } from '../operations/installSkill'
import { useGraphStore } from '../store'
import { useFloatingMotion } from '../useFloatingMotion'
import { usePeacockTransition } from '../usePeacockTransition'
import type { CapabilityGroup, SkillNodeData, SkillCategory } from '../types'

// ─── Orbital tile system ──────────────────────────────────────────────────────
//
// Every orbital renders as ONE tile family (the language the Model orbital
// established): an OPAQUE accent-tinted disc (`color-mix(accent, var(--surface))`
// — never a transparent wash), a solid accent ring, a soft accent shadow, the
// glyph in full accent colour, and a theme-foreground label below. The tile
// ACCENT is TYPE-coded so the fan reads at a glance:
//
//   provider brand → the LLM model
//   mint           → skills / tools
//   violet         → MCP connectors (ResourceNode) and OpenClaw plugins
//   slate          → the runtime built-ins rollup
//   amber          → Leadership (Boo Zero)
//
// The category picks only the GLYPH for skill tiles (variety within the mint
// family); the old per-category tile colours read as noise next to the
// type-coded connectors/model.
//
// A GROUP tile keeps its members' accent and glyph and adds a stack of discs
// behind it, so forty plugins read as one violet thing with more behind it.

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

// A group tile wears what its members would have worn one by one.
const GROUP_VISUAL: Record<CapabilityClass, { color: string; Icon: LucideIcon }> = {
  plugin: { color: 'var(--violet)', Icon: Puzzle },
  connector: { color: 'var(--violet)', Icon: Cable },
  tool: { color: 'var(--mint)', Icon: Wrench },
  skill: { color: 'var(--mint)', Icon: FileText },
  builtin: { color: 'var(--secondary)', Icon: Blocks },
}

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
  selected,
  positionAbsoluteX,
  positionAbsoluteY,
}: NodeProps<Node<SkillNodeData, 'skill'>>) {
  const {
    name,
    displayName,
    group,
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
    agentIds,
    orbitIndex,
    orbitCount,
  } = data
  // Unavailable OR policy-disabled → greyed (opacity + grayscale), matching the
  // dashboard treatment. A denied tool must never read as "the agent has this".
  const greyed = available === false || enabled === false
  const floatRef = useFloatingMotion(nodeId, 'skill', dragging)
  // Hover/tap springs are decorative feedback — dropped under reduced motion,
  // matching the graph's RAF loops (`@/lib/prefersReducedMotion`).
  const reduceMotion = useReducedMotion()
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
      : group
        ? GROUP_VISUAL[group.cls]
        : isBuiltinRollup
          ? { color: 'var(--secondary)', Icon: Blocks }
          : { color: 'var(--mint)', Icon: CATEGORY_ICON[category] ?? Wrench }
  // What a person reads. `name` stays raw because installs send it to the server.
  const label = displayName ?? name
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

  // Peacock-feather expand / collapse — the child springs out FROM the
  // parent Boo's live center to its orbital spot (and folds back in on
  // collapse), staggered in arc order. When `isVisible` is undefined (e.g.
  // MiniGraph context), the hook returns a no-op identity transition so
  // the node renders normally with no animation.
  const peacock = usePeacockTransition({
    nodeId,
    isVisible,
    parentAgentId: agentIds?.[0] ?? null,
    positionAbsoluteX,
    positionAbsoluteY,
    selfSize: circle,
    orbitIndex,
    orbitCount,
  })

  return (
    // Static root: the center Handle lives here, OUTSIDE the animated /
    // floating wrappers, so edges anchor to the node's stable geometric
    // center — the gentle idle bob and the peacock transform never detach
    // an edge endpoint from its node.
    <div style={{ width: circle, height: circle, position: 'relative' }}>
      {/* A group's members, on selection. Mounted only while open, so a closed
          group tile subscribes to nothing. */}
      {group && selected && isVisible !== false && (
        <GroupToolbar group={group} label={label} tileY={positionAbsoluteY} tileSize={circle} />
      )}
      <motion.div
        initial={peacock.initial}
        animate={peacock.animate}
        transition={peacock.transition}
        style={{
          width: circle,
          height: circle,
          // Pin the transform origin to the visual center so the collapse
          // scale shrinks INTO the disc center as it travels back to the
          // parent Boo.
          transformOrigin: 'center center',
          pointerEvents: peacock.pointerEvents,
        }}
      >
        <div ref={floatRef}>
          <div
            title={
              greyed
                ? `${description ?? label} — ${enabled === false ? 'disabled' : 'unavailable'}`
                : (description ?? label)
            }
            className="group"
            style={{
              width: circle,
              height: circle,
              position: 'relative',
              overflow: 'visible',
              opacity: greyed ? (isHighlighted ? 0.5 : 0.16) : isHighlighted ? 1 : 0.22,
              filter: greyed ? 'grayscale(1)' : undefined,
              transition: 'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1), filter 0.3s ease',
            }}
          >
            {/* A group's stack: two discs behind the tile, offset up and to the
              right, so "there is more behind this" reads before the label does. */}
            {group &&
              [5, 2.5].map((offset) => (
                <span
                  key={offset}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    transform: `translate(${offset}px, -${offset}px)`,
                    background: `color-mix(in srgb, ${color} ${offset > 3 ? 8 : 11}%, var(--surface))`,
                    border: `1.5px solid color-mix(in srgb, ${color} ${offset > 3 ? 35 : 50}%, transparent)`,
                  }}
                />
              ))}
            {/* The tile disc — ONE family for every orbital: an OPAQUE
              accent-tinted surface (never a transparent wash), a solid accent
              ring, and a soft accent shadow. The Model tile tints slightly
              deeper + carries a full-strength ring so it stays the anchor.
              Hover lifts the disc with a small spring scale — a quiet
              micro-interaction that makes the fan feel touchable. */}
            <motion.div
              whileHover={reduceMotion ? undefined : { scale: 1.08 }}
              whileTap={reduceMotion ? undefined : { scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 420, damping: 24 }}
              style={{
                // Positioned, or the absolute stack discs would paint over it.
                position: 'relative',
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
            </motion.div>

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
              {label}
            </div>
          </div>
        </div>
      </motion.div>

      {/* ── Static-root handles ──────────────────────────────────────────
          ALL handles live on the STATIC root, outside the peacock/floating
          transforms. React Flow measures handle bounds ONCE at mount
          (getBoundingClientRect, transform-affected) — a handle mounted
          inside the collapsed translate-to-parent transform would be
          registered 120–220px away from the tile and never re-measured,
          breaking the install drag origin and creating phantom snap
          points. On the root they measure at their true resting spots;
          visibility rides a CSS fade tied to the peacock state. */}

      {/* Left handle — target for incoming edges from BooNodes. Hidden for
          the non-installable Leadership + Model orbitals. */}
      {showInstall && (
        <Handle
          type="target"
          position={Position.Left}
          style={{
            ...handleStyle,
            borderColor: `color-mix(in srgb, ${color} 33%, transparent)`,
            opacity: isVisible === false ? 0 : 1,
            pointerEvents: isVisible === false ? 'none' : undefined,
            transition: 'opacity 0.2s ease',
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
            opacity: isVisible === false ? 0 : 1,
            pointerEvents: isVisible === false ? 'none' : undefined,
            transition: 'opacity 0.2s ease',
          }}
        />
      )}

      {/* Center handle — invisible, edge routing only. */}
      <Handle id="center" type="target" position={Position.Left} style={centerHandleStyle} />
    </div>
  )
})

// ─── GroupToolbar ────────────────────────────────────────────────────────────
//
// Portal-rendered by React Flow, the way the connector tile's toolbar is, so the
// list is screen-sized at any zoom and never clipped by the ring.
//
// IT OPENS AWAY FROM THE NEARER EDGE of the canvas and is never taller than the
// room on that side. Opened upward from a tile near the top, a list of forty
// lost its heading and first rows off the top of the canvas.

const LIST_GAP = 14 // between the tile and the list
const LIST_MAX = 300
const LIST_MIN = 120
const LIST_STEP = 20 // re-render the list per 20px of room, not per pixel of pan

function GroupToolbar({
  group,
  label,
  tileY,
  tileSize,
}: {
  group: CapabilityGroup
  label: string
  /** The tile's top, in graph units. */
  tileY: number
  tileSize: number
}) {
  // One string, so the list re-renders only when its side or its height changes.
  const fit = useStore(
    useCallback(
      (s: ReactFlowState) => {
        const [, ty, zoom] = s.transform
        const top = tileY * zoom + ty
        const above = top - LIST_GAP
        const below = s.height - (top + tileSize * zoom) - LIST_GAP
        const up = above >= below
        const room = Math.floor(((up ? above : below) - 8) / LIST_STEP) * LIST_STEP
        return `${up ? 'top' : 'bottom'}:${Math.min(LIST_MAX, Math.max(LIST_MIN, room))}`
      },
      [tileY, tileSize],
    ),
  )
  const [side, height] = fit.split(':')
  return (
    <NodeToolbar
      isVisible
      position={side === 'top' ? Position.Top : Position.Bottom}
      offset={LIST_GAP}
    >
      <GroupMemberList group={group} label={label} maxHeight={Number(height)} />
    </NodeToolbar>
  )
}

// ─── GroupMemberList ─────────────────────────────────────────────────────────
//
// What a group tile stands for, one line each. Read-only by construction: only
// capabilities the canvas cannot act on ever fold (see `groupClassFor`), so a
// row has nothing to offer but its name and whether it is on. A provider
// plugin wears its provider's mark, which is how a list of forty stays
// scannable.

function GroupMemberList({
  group,
  label,
  maxHeight,
}: {
  group: CapabilityGroup
  label: string
  maxHeight: number
}) {
  const { Icon } = GROUP_VISUAL[group.cls]
  return (
    <div
      // nowheel: a wheel over the list scrolls it instead of zooming the canvas.
      className="nowheel nodrag nopan surface-floating-tier flex w-[232px] flex-col rounded-xl"
      style={{ maxHeight }}
    >
      <div className="border-b border-border px-3 pt-2.5 pb-2">
        <div className="text-[12px] font-semibold text-foreground">{label}</div>
        {group.runtime && (
          <div className="text-[11px] text-muted-foreground">
            From {runtimeLabel(group.runtime)}
          </div>
        )}
      </div>
      <ul className="m-0 min-h-0 list-none overflow-y-auto px-1.5 py-1" aria-label={label}>
        {group.members.map((member, i) => (
          <li
            key={`${member.name}-${i}`}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px]"
          >
            <span
              aria-hidden
              className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
              style={member.providerId ? { color: providerInk(member.providerId) } : undefined}
            >
              {member.providerId ? (
                <ProviderGlyph id={member.providerId} size={14} />
              ) : (
                <Icon size={13} strokeWidth={2} />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground">{member.name}</span>
            {member.state && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {member.state === 'off' ? 'Off' : 'Unavailable'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A provider mark's ink: its brand colour, or the theme's for monochrome brands. */
function providerInk(id: ProviderId): string {
  const brand = PROVIDER_BRAND[id].color
  return brand === 'currentColor' ? 'var(--foreground)' : brand
}
