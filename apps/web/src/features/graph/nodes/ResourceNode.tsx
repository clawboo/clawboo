import { memo, useRef } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  Cable,
  Database,
  KanbanSquare,
  MessagesSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Handle, NodeToolbar, Position, useStore } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { useGraphStore } from '../store'
import { useViewStore } from '@/stores/view'
import { useToastStore } from '@/stores/toast'
import { disableCapability, enableCapability } from '@/lib/capabilitiesClient'
import { detachGrant } from '../operations/revokeGrant'
import { useFloatingMotion } from '../useFloatingMotion'
import { usePeacockTransition } from '../usePeacockTransition'
import type { ResourceNodeData, ConnectorServiceKind } from '../types'
import { capabilityBadge, capabilityReason } from './capabilityBadge'

// ─── ResourceNode — the MCP-connector tile ────────────────────────────────────
//
// Part of the unified orbital tile family (see SkillNode's tile-system note):
// an OPAQUE violet-tinted disc + solid violet ring + a per-service glyph +
// a theme-foreground label. Violet is the CONNECTOR type accent — at a glance:
// violet = an attached MCP server, mint = a skill/tool, brand = the model,
// slate = built-ins, amber = leadership. Replaces the old faint amber card
// with the generic Plug icon and the shouty truncated uppercase label.

const VIOLET = 'var(--violet)'
const CIRCLE = 46 // matches the regular SkillNode tile
/** Below this zoom, orbital tiles collapse to flat dots (see the LOD note). */
const LOD_ZOOM = 0.4
const LOD_DOT = 10

// Each clawboo MCP server gets a MEANINGFUL glyph (lucide, never emoji):
// memory → Database, tasks → Kanban, tools → Wrench, team chat → Messages.
// Unknown / third-party servers fall back to the Cable connector glyph.
const SERVICE_ICON: Record<ConnectorServiceKind, LucideIcon> = {
  memory: Database,
  tasks: KanbanSquare,
  tools: Wrench,
  teamchat: MessagesSquare,
  generic: Cable,
}

// ─── Handle style ─────────────────────────────────────────────────────────────

const handleStyle = {
  background: 'transparent',
  border: '1.5px solid rgb(var(--violet-rgb) / 0.45)',
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

export const ResourceNode = memo(function ResourceNode({
  id: nodeId,
  data,
  dragging,
  positionAbsoluteX,
  positionAbsoluteY,
  selected,
}: NodeProps<Node<ResourceNodeData, 'resource'>>) {
  const { name, fullName, serviceKind, isVisible, available, enabled, agentIds } = data
  const { orbitIndex, orbitCount, health, healthDetail, diagnostics, hint, grantIds, connectorId } =
    data
  const { grantCount, grantState } = data
  // ONE badge, strict precedence — see ./capabilityBadge. The tile previously
  // collapsed the whole lifecycle into `status !== 'disabled'`, so a connector
  // waiting on auth rendered as fully normal while the dashboard got it right.
  const badge = capabilityBadge({ health, available, enabled, grantIds, grantState })
  const reason = capabilityReason({ badge, diagnostics, healthDetail, hint })
  // Two dialects, deliberately distinct (the 04 §5 rule): DIMMED means a human
  // turned it off — a choice — and keeps its color; GREYED + grayscale means it
  // cannot run — a condition. Collapsing them is what made a pending-auth
  // connector read the same as a deliberately disabled one.
  const unavailable = available === false || health === 'error' || health === 'degraded'
  const off = enabled === false
  const greyed = unavailable || off
  const Icon = SERVICE_ICON[serviceKind ?? 'generic'] ?? Cable
  // Float with the SKILL motion profile: connector tiles are visual peers of
  // skill tiles in the same orbital fan, so a static tile next to gently
  // bobbing siblings would read as frozen/broken, not calm.
  // ── LOD ───────────────────────────────────────────────────────────────────
  // Below this zoom a 46px tile is ~18px on screen: the label is unreadable, the
  // badge is a smudge, and the per-frame floating rAF write buys nothing. The
  // selector returns a BOOLEAN, not the zoom, so this subscription re-renders
  // only when the threshold is crossed — subscribing to the raw zoom would
  // re-render every tile on every wheel tick, which is the opposite of the point.
  const farZoom = useStore((st) => st.transform[2] < LOD_ZOOM)
  const floatRef = useFloatingMotion(nodeId, 'skill', dragging, farZoom)
  // See SkillNode: decorative hover/tap spring, dropped under reduced motion.
  const reduceMotion = useReducedMotion()

  // Hover cascade — dim when another node is hovered
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(nodeId) ?? false),
  )

  // Peacock-feather expand / collapse — springs out FROM the parent Boo's
  // live center in arc order (see usePeacockTransition). Returns no-op
  // props when `isVisible` is undefined (MiniGraph context).
  const peacock = usePeacockTransition({
    nodeId,
    isVisible,
    parentAgentId: agentIds?.[0] ?? null,
    positionAbsoluteX,
    positionAbsoluteY,
    selfSize: CIRCLE,
    orbitIndex,
    orbitCount,
  })

  const tooltipBase = fullName && fullName !== name ? `${name} — ${fullName}` : name

  // At fleet zoom the tile is a dot. Deliberately still MOUNTED and still
  // carrying its handles: unmounting would break every edge anchored to it, and
  // the whole point is that zooming out stays cheap, not that it changes the
  // graph's topology. The accessible name survives because the wrapper keeps it.
  if (farZoom && isVisible !== false) {
    return (
      <div
        style={{ width: CIRCLE, height: CIRCLE, position: 'relative' }}
        title={reason ? `${tooltipBase} — ${reason}` : tooltipBase}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: (CIRCLE - LOD_DOT) / 2,
            left: (CIRCLE - LOD_DOT) / 2,
            width: LOD_DOT,
            height: LOD_DOT,
            borderRadius: '50%',
            // Badge color wins at this zoom: at fleet scale the only thing worth
            // a pixel is "something here needs you".
            background: badge ? badge.color : VIOLET,
            opacity: greyed ? 0.4 : 0.9,
          }}
        />
        <Handle type="target" position={Position.Left} style={centerHandleStyle} />
        <Handle id="center" type="target" position={Position.Left} style={centerHandleStyle} />
        {/* The grant SOURCE handle survives fleet zoom too. Dropping it here
            would make drag-to-grant depend on how far the user happens to be
            zoomed out, and a gesture that silently stops existing is worse than
            one that never existed. Invisible at this scale (the tile is a dot) but
            still hit-testable, and deliberately NOT centerHandleStyle, which
            centers the handle and disables pointer events. */}
        {connectorId != null && (
          <Handle
            id="grant"
            type="source"
            position={Position.Right}
            style={{ opacity: 0, pointerEvents: 'auto' }}
          />
        )}
      </div>
    )
  }

  return (
    // Static root: the center Handle lives here, OUTSIDE the animated /
    // floating wrappers, so edges anchor to the stable geometric center.
    <div style={{ width: CIRCLE, height: CIRCLE, position: 'relative' }}>
      {/* Selection toolbar — portal-rendered by React Flow, so it is never
          clipped by the orbital ring. Every button is gated on the RECORD:
          an action that cannot complete does not render (the CapabilitiesPanel
          actionsFor rule, applied to the canvas). Ordered frequency-then-danger. */}
      <NodeToolbar isVisible={selected && isVisible !== false} position={Position.Top} offset={34}>
        <ResourceToolbar data={data} />
      </NodeToolbar>
      <motion.div
        initial={peacock.initial}
        animate={peacock.animate}
        transition={peacock.transition}
        style={{
          width: CIRCLE,
          height: CIRCLE,
          transformOrigin: 'center center',
          pointerEvents: peacock.pointerEvents,
        }}
      >
        <div ref={floatRef}>
          <div
            title={
              reason
                ? `${tooltipBase} — ${reason}`
                : `${tooltipBase} · attached MCP server${
                    (grantCount ?? 0) >= 2 ? ` · shared by ${grantCount} agents` : ''
                  }`
            }
            data-off={off || undefined}
            style={{
              width: CIRCLE,
              height: CIRCLE,
              position: 'relative',
              overflow: 'visible',
              opacity: greyed ? (isHighlighted ? 0.5 : 0.16) : isHighlighted ? 1 : 0.22,
              filter: unavailable ? 'grayscale(1)' : undefined,
              transition: 'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1), filter 0.3s ease',
            }}
          >
            {/* The tile disc — opaque violet-tinted surface (the connector
              accent). Hover lifts it with a small spring scale, matching
              the SkillNode micro-interaction. */}
            <motion.div
              whileHover={reduceMotion ? undefined : { scale: 1.08 }}
              whileTap={reduceMotion ? undefined : { scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 420, damping: 24 }}
              style={{
                width: CIRCLE,
                height: CIRCLE,
                borderRadius: '50%',
                background: `color-mix(in srgb, ${VIOLET} 15%, var(--surface))`,
                border: `1.5px solid color-mix(in srgb, ${VIOLET} 65%, transparent)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: `0 2px 8px color-mix(in srgb, ${VIOLET} 20%, transparent), inset 0 1px 0 rgb(var(--foreground-rgb) / 0.07)`,
              }}
            >
              <Icon size={20} strokeWidth={2} aria-hidden style={{ color: VIOLET }} />
            </motion.div>

            {/* ONE badge, top-right of the disc. Suppressed while collapsed: a
              collapsed ring of fifteen warnings is unactionable noise, and the
              parent Boo carries the roll-up instead. */}
            {badge && isVisible !== false && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  top: -1,
                  right: -1,
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: badge.color,
                  border: '2px solid var(--surface)',
                  animation: badge.pulse
                    ? 'clawboo-badge-pulse 1.8s ease-in-out infinite'
                    : undefined,
                }}
              />
            )}

            {/* Shared by N agents. Hovering the tile highlights its siblings via
              the existing hover cascade, so the chip only has to say "there are
              others" — it does not need to name them. */}
            {(grantCount ?? 0) >= 2 && isVisible !== false && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  bottom: -1,
                  right: -3,
                  padding: '0 4px',
                  borderRadius: 999,
                  fontSize: 9,
                  fontWeight: 600,
                  lineHeight: '13px',
                  color: 'var(--foreground)',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                x{grantCount}
              </span>
            )}

            {/* Name below the disc — theme foreground (the accent lives on the tile). */}
            <div
              style={{
                position: 'absolute',
                top: CIRCLE + 6,
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--foreground)',
                whiteSpace: 'nowrap',
                maxWidth: 104,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textAlign: 'center',
                letterSpacing: '0.02em',
              }}
            >
              {name}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Left handle — target for incoming edges from BooNodes. Lives on the
          STATIC root (see SkillNode's static-root-handles note): handle
          bounds are measured once at mount, so a handle inside the
          collapsed peacock transform would register far from the tile.
          Visibility rides a CSS fade tied to the peacock state. */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          ...handleStyle,
          opacity: isVisible === false ? 0 : 1,
          pointerEvents: isVisible === false ? 'none' : undefined,
          transition: 'opacity 0.2s ease',
        }}
      />

      {/* Right handle — SOURCE, so a connector tile can be dragged onto a second
          Boo to grant it there. Both handles were `type="target"` until now,
          which made the whole drag-to-grant gesture impossible by construction,
          not by policy.

          Rendered on EVERY connector tile, not only an already-shared one.
          Gating it on `grantIds` was a deadlock: the composer this handle opens
          is the only thing that mints a grant, so a tile with no grant could
          never get one. Sharing is an affordance of BEING a connector; the tile
          itself is the proof the agent has it. Detach, further down, stays gated
          on an actual grant, because that one really does need something to
          revoke. */}
      {connectorId != null && (
        <Handle
          id="grant"
          type="source"
          position={Position.Right}
          style={{
            ...handleStyle,
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

// ─── ResourceToolbar ─────────────────────────────────────────────────────────
//
// Pure function of the record. Buttons render only when their action is real:
//   Configure       always (opens the Capabilities panel — the detail surface)
//   Disable/Enable  writable rows only (the existing REST write)
//   Sign in         health 'needs-auth' only — the hint IS the action today
//   Retry           health 'error' | 'degraded' only (re-reads the inventory)
//   Detach          grant-backed rows only (revoke + the undo toast)

const TOOLBAR_BTN =
  'rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium ' +
  'text-foreground transition-colors hover:border-border-strong hover:bg-surface-raised'

function ResourceToolbar({ data }: { data: ResourceNodeData }) {
  const { capabilityId, writable, enabled, health, hint, grantIds, name } = data
  // A real ref, not a per-render object: the guard must survive re-renders or a
  // double-click races two toggle writes.
  const busyRef = useRef(false)

  const toggleEnabled = async () => {
    if (!capabilityId || busyRef.current) return
    busyRef.current = true
    const result =
      enabled === false
        ? await enableCapability(capabilityId)
        : await disableCapability(capabilityId)
    busyRef.current = false
    if (!result.ok) {
      useToastStore.getState().addToast({
        message:
          enabled === false
            ? `Could not enable ${name}. It is still off.`
            : `Could not disable ${name}. It is still on.`,
        type: 'error',
      })
      return
    }
    // No success toast: the state changes under the cursor and the button's
    // accessible name flips, which announces it.
    useGraphStore.getState().triggerRefresh()
  }

  return (
    <div className="flex items-center gap-1.5" role="toolbar" aria-label={`${name} actions`}>
      <button
        type="button"
        className={TOOLBAR_BTN}
        onClick={() => useViewStore.getState().navigateTo('capabilities')}
      >
        Configure
      </button>
      {writable === true && capabilityId && (
        <button type="button" className={TOOLBAR_BTN} onClick={() => void toggleEnabled()}>
          {enabled === false ? 'Enable' : 'Disable'}
        </button>
      )}
      {health === 'needs-auth' && (
        <button
          type="button"
          className={TOOLBAR_BTN}
          title={hint}
          onClick={() =>
            useToastStore.getState().addToast({
              // The source-supplied hint verbatim — the graph never paraphrases
              // a per-runtime remedy into a string of its own.
              message: hint ?? `${name} needs sign-in.`,
              type: 'info',
              ttlMs: 8000,
            })
          }
        >
          Sign in
        </button>
      )}
      {(health === 'error' || health === 'degraded') && (
        <button
          type="button"
          className={TOOLBAR_BTN}
          onClick={() => useGraphStore.getState().triggerRefresh()}
        >
          Retry
        </button>
      )}
      {(grantIds?.length ?? 0) > 0 && (
        <button
          type="button"
          className={TOOLBAR_BTN}
          onClick={() =>
            // agentIds carries IDs, not display names — the toast copy adapts
            // rather than printing an id at the user.
            void detachGrant({ grantId: grantIds![0]!, connectorName: name })
          }
        >
          Detach
        </button>
      )}
    </div>
  )
}
