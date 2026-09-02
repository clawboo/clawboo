// BrowserDock — the agent's screen, floating beside the graph.
//
// ─── The shape ──────────────────────────────────────────────────────────────
//
// A screen and the faces you can switch between. Nothing else: no title bar, no
// chrome, no close button, no caption. The frame IS the panel, so the thing on
// screen is the agent's page rather than a window containing the agent's page.
//
// It hugs the capture instead of filling the canvas height. A browser
// screenshot is landscape and a full-height column is portrait, so a spanning
// panel is mostly empty ground no matter how the image is aligned inside it —
// and empty ground around a small picture reads as a layout that failed rather
// than one that was composed.
//
// Dismissal lives on the toolbar toggle that opened it (which stays lit while
// open) and on Escape. A close button would be the fourth affordance for the
// same action and the only piece of chrome on an otherwise chromeless surface.
//
// ─── Motion ─────────────────────────────────────────────────────────────────
//
// The brief was "push the graph left, smoothly, no lag". The naive reading is
// to shrink the canvas by animating a width, and that is the one thing that
// cannot be smooth: width animates LAYOUT, so every frame reflows the React
// Flow container and React Flow re-measures on every resize tick.
//
// Nothing here animates layout. Three things move, all on `transform`, all on
// one curve and duration, so they read as a single gesture:
//
//   1. this panel        translateX — slides in from the right edge
//   2. the graph toolbar translateX — steps aside to make room  (GhostGraph)
//   3. the canvas        React Flow's own viewport pan          (GhostGraph)
//
// The curve is the app's `cubic-bezier(0.32, 0.72, 0, 1)`, reused verbatim
// rather than re-picked: a panel that eases differently from the rest of the
// app is the tell that it was bolted on.

import { useEffect, useMemo, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useAgentScreenshot } from '@/features/workspace/useAgentScreenshot'
import { useBrowserGrant } from '@/features/workspace/useBrowserGrant'

import { freshestAgent, useAgentFrames } from './useAgentFrames'

/** Frame width. The canvas keeps the majority of the viewport. */
export const DOCK_WIDTH = 420
/** Breathing room from the canvas edge. Matches the graph toolbar's own inset. */
const EDGE = 16
/**
 * The window's shape, always.
 *
 * A real browser window does not reshape itself around the page inside it, and
 * neither should this: an agent driving a computer is looking at a landscape
 * viewport, so that is what the frame is. Letting the capture drive the aspect
 * meant a phone-viewport screenshot turned the panel into a 900px column.
 *
 * The capture is fitted INSIDE this (`object-fit: contain`), so a portrait
 * grab letterboxes the way a phone screenshot does in any desktop viewer.
 */
const WINDOW_ASPECT = '16 / 10'

export interface DockAgent {
  id: string
  name: string
}

export function BrowserDock({
  open,
  agents,
  selectedAgentId,
  onSelectAgent,
  onClose,
}: {
  open: boolean
  agents: readonly DockAgent[]
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  // A CSS transition does NOT honour prefers-reduced-motion on its own, and a
  // 420px surface sweeping across the viewport is exactly the motion the
  // setting exists to suppress. The panel still moves — it just arrives.
  const reduceMotion = useReducedMotion()

  const agentIds = useMemo(() => agents.map((a) => a.id), [agents])
  // Probed only while open: a closed dock has no reason to poll N routes.
  const frames = useAgentFrames(agentIds, open)
  const { meta, checked, src } = useAgentScreenshot(open ? selectedAgentId : null, open)
  // An ungranted browser and an unused one look identical on screen. They are
  // not the same fact, and only one of them is something a person can act on.
  const grant = useBrowserGrant(open ? selectedAgentId : null, open)

  // Open onto the freshest frame rather than whichever agent the graph listed
  // first, so the dock shows something the moment it appears. The ref resets on
  // close, so it lands once per opening and never overrides the user's choice.
  const autoPickedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      autoPickedRef.current = false
      return
    }
    if (autoPickedRef.current) return
    const freshest = freshestAgent(frames)
    if (!freshest) return
    autoPickedRef.current = true
    if (freshest !== selectedAgentId) onSelectAgent(freshest)
  }, [open, frames, selectedAgentId, onSelectAgent])

  // Escape closes. Focus is NOT trapped: this floats beside the graph, it is
  // not a modal over it, and trapping would make Tab feel broken on the canvas.
  useEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div
      ref={panelRef}
      role="complementary"
      aria-label="Agent browser"
      aria-hidden={!open}
      style={{
        position: 'absolute',
        right: EDGE,
        // Vertically centred, so the panel reads as floating over the canvas
        // rather than anchored to a corner. The Y half of the transform is
        // constant; only X animates.
        top: '50%',
        width: `min(${DOCK_WIDTH}px, calc(100% - ${EDGE * 2}px))`,
        // Bounded by the GRAPH PANE, not the viewport. The pane is short in the
        // team-chat split view, and a `100vh` cap let the panel hang out of it
        // in both directions.
        maxHeight: `calc(100% - ${EDGE * 2}px)`,
        zIndex: 25,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'center',
        gap: 10,
        transform: open ? 'translate(0, -50%)' : `translate(calc(100% + ${EDGE * 2}px), -50%)`,
        transition: reduceMotion ? 'none' : 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      {/* ── Faces ── a floating pill of avatars, centred over the screen.
          Avatar only: each Boo already has its own colour and face, and a name
          beside every one would out-weigh the picture it sits above. The name
          is on hover and in the accessible name. */}
      {agents.length > 1 && (
        <div
          role="tablist"
          aria-label="Choose an agent"
          className="surface-floating-tier"
          style={{
            alignSelf: 'center',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: 4,
            borderRadius: 999,
          }}
        >
          {agents.map((agent) => {
            const active = agent.id === selectedAgentId
            const hasFrame = frames.get(agent.id) != null
            return (
              <button
                key={agent.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={hasFrame ? `${agent.name} — has a frame` : agent.name}
                title={agent.name}
                tabIndex={open ? 0 : -1}
                onClick={() => onSelectAgent(agent.id)}
                className="relative grid cursor-pointer place-items-center rounded-full transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                style={{
                  width: 30,
                  height: 30,
                  border: 'none',
                  // The selected face sits on a tinted disc; the others are
                  // dimmed. Opacity and colour only — a scale would nudge its
                  // neighbours and make the row twitch on hover.
                  background: active ? 'rgb(var(--primary-rgb) / 0.14)' : 'transparent',
                  opacity: active ? 1 : 0.55,
                }}
              >
                <AgentBooAvatar agentId={agent.id} size={20} />
                {/* Has something to show. Never the only signal — the selected
                    face is also discs-and-full-opacity, and the name says so. */}
                {hasFrame && (
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      right: 1,
                      bottom: 1,
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: 'var(--mint)',
                      boxShadow: '0 0 0 1.5px var(--surface-floating)',
                    }}
                  />
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* ── The screen ── the frame itself is the panel. */}
      <div
        style={{
          // 16px, and the OVERLAY shadow rather than the floating one. This is
          // a screen lying on the canvas, not a control hovering just above it,
          // and the lighter tier left a big pale rectangle reading as flat
          // against a pale canvas. The heavier tier is what separates them.
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid var(--border-floating)',
          boxShadow: 'var(--shadow-overlay)',
          // A captured page is its own document with its own background.
          background: 'var(--surface)',
          width: '100%',
          // Constant shape whatever the capture is, so the panel never resizes
          // under the pointer when a new frame lands.
          aspectRatio: WINDOW_ASPECT,
          // Shrink rather than overflow when the graph pane is short. `%` of the
          // PANEL, which is itself a % of the graph container — so this tracks
          // the pane, not the viewport.
          minHeight: 0,
          maxHeight: '100%',
          // `relative` so the frame can give the image a DEFINITE box below. A
          // percentage height cannot resolve against an `aspect-ratio`-computed
          // parent, so `height: 100%` silently fell back to the image's natural
          // height — a portrait grab rendered 905px tall inside a 174px frame
          // and was merely CLIPPED by `overflow: hidden` rather than fitted.
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {src && meta ? (
          <img
            // `ts` in the key remounts on a new frame. The URL is stable by
            // design ("the latest frame"), so without this the panel would show
            // the first screenshot for the rest of the run.
            key={meta.ts}
            src={src}
            alt={`Screenshot captured by ${meta.toolName}`}
            title={`${meta.toolName} · ${new Date(meta.ts).toLocaleTimeString()}`}
            // Fitted inside the fixed window, never driving its size. A
            // landscape grab fills it; a portrait one letterboxes, which is what
            // a phone screenshot looks like in any desktop viewer.
            style={{
              position: 'absolute',
              inset: 0,
              display: 'block',
              width: '100%',
              height: '100%',
              objectFit: 'contain',
            }}
          />
        ) : (
          <p
            className="text-muted-foreground"
            style={{ fontSize: 12, padding: '0 24px', textAlign: 'center', lineHeight: 1.6 }}
          >
            {!checked
              ? ''
              : agents.length === 0
                ? 'No agents on this graph yet.'
                : grant === 'missing'
                  ? 'No browser granted to this Boo.'
                  : 'Nothing captured yet.'}
          </p>
        )}
      </div>
    </div>
  )
}
