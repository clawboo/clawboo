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
import { apiFetch } from '@clawboo/control-client'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { useAgentScreenshot } from '@/features/workspace/useAgentScreenshot'
import { useBrowserGrant } from '@/features/workspace/useBrowserGrant'

import { freshestAgent, useAgentFrames } from './useAgentFrames'

/**
 * Whether this Boo's browsing is something clawboo can actually show.
 *
 * Only the native runtime is brokered through clawboo's own tools, so only it is
 * governed by the per-agent browser and captured into this panel. Everything else
 * carries its own toolset: it may browse perfectly well, in a browser clawboo
 * neither launched nor can photograph.
 */
function usesClawbooBrowser(agent: DockAgent): boolean {
  const rt = (agent.runtime ?? '').trim()
  // Unknown runtime is treated as visible: an agent whose runtime never hydrated
  // should fall back to the ordinary empty state rather than being told its
  // screen is unavailable on the strength of a missing field.
  return rt === '' || rt === 'clawboo-native'
}

/** The runtime's name as a person would write it. */
function runtimeLabel(runtime: string | null | undefined): string {
  const rt = (runtime ?? '').trim()
  if (rt === 'openclaw') return 'OpenClaw'
  if (rt === 'claude-code') return 'Claude Code'
  if (rt === 'hermes') return 'Hermes'
  return rt || 'another runtime'
}

/** Frame width. The canvas keeps the majority of the viewport. */
export const DOCK_WIDTH = 420
/** Breathing room from the canvas edge. Matches the graph toolbar's own inset. */
const EDGE = 16
/**
 * The chooser's corner radius, and ALSO the distance the team bar sinks into the
 * faces row. The two are the same number by necessity, not by taste: the overlap
 * has to bury the row's top corner arc for the pair to merge into one silhouette,
 * and anything less leaves a notch either side whenever the two rows come out the
 * same width. Changing one without the other reintroduces it.
 */
const CHOOSER_RADIUS = 14

/**
 * How far the bar's sides flare out into the row's top edge, rounding the inside
 * corner the two make. See `.chooser-bar::before`.
 */
const CHOOSER_FILLET = 8

/**
 * The narrowest the faces row may be beyond the bar, per side.
 *
 * This exists to make the two rows NEVER the same width, and that is worth the
 * words. Equal widths were the case that forced everything else: the bar's
 * bottom had to sink far enough into the row to bury its top corner arc, or the
 * two pinched at the seam — so the overlap had to be the whole corner radius,
 * and the row then had to pad past that overlap so the bar did not cover the
 * Boos. A round corner therefore BOUGHT dead space above every face, and
 * trimming the space squared off the corner. The two could not both be right.
 *
 * Guaranteeing a shoulder retires that case. The bar carries this as a margin,
 * so the grid column is at least the bar plus two of these, the row's corner arc
 * always lands clear of the bar, and the overlap collapses to the hairline below.
 * It is the corner radius plus the fillet because those two consume the shoulder
 * end to end: the arc, then the flare, then the bar.
 */
const MIN_SHOULDER = CHOOSER_RADIUS + CHOOSER_FILLET

/**
 * How far the bar sinks into the row: one pixel, purely so the two fills meet
 * without a seam of background showing between them at fractional device ratios.
 * With a shoulder guaranteed there is no arc left to bury, so this no longer has
 * to be the corner radius, and the row no longer has to reserve room for it.
 */
const SEAM_RADIUS = 1

/**
 * Shrink an icon only when it really is more than one glyph.
 *
 * `.length` counts UTF-16 code units, so a plain 🚀 measures 2 and was drawn a
 * size smaller than a ⭐ measuring 1 — including against the teamless '⋯' tab,
 * which came out the largest thing in the row. Code points put every single-glyph
 * icon on the same footing and still catch the genuinely wide ones (a ZWJ
 * sequence is several code points).
 */
function iconFontSize(icon: string): number {
  return Array.from(icon).length > 1 ? 12 : 14
}
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
  /**
   * Which runtime backs this Boo.
   *
   * The panel can only ever show a frame from the browser CONNECTOR. An
   * agent on an external runtime has its own toolset and can open a page
   * without clawboo ever seeing it, so for those the absence of a frame says
   * nothing about whether it browsed. Without this the panel reports "no page
   * opened" at a Boo that just opened one.
   */
  runtime?: string | null
}

/** A team tab. Empty on a team graph, which has already answered the question. */
export interface DockTeam {
  id: string
  name: string
  /** The emoji the team picked; the tab is icon-only. */
  icon: string
}

export function BrowserDock({
  open,
  agents,
  selectedAgentId,
  onSelectAgent,
  teams,
  selectedTeamId,
  onSelectTeam,
  onClose,
}: {
  open: boolean
  agents: readonly DockAgent[]
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  /** Empty or single on a team graph: the tab row then does not render. */
  teams: readonly DockTeam[]
  selectedTeamId: string | null
  onSelectTeam: (teamId: string) => void
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
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null

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

  // Photograph this Boo's browser when the panel opens, whether or not a frame
  // already exists.
  //
  // THIS IS WHAT MAKES THE PANEL WORK AT ALL. A frame is otherwise only ever
  // captured as a side effect of a tool that returns an IMAGE, and navigating is
  // not one: `browser_navigate` and `navigate_page` return text. So a Boo could
  // open a page, sit on it, and the panel would still read "No Boo has opened a
  // page yet" until it happened to take a screenshot of its own accord. Gating
  // this on a frame already existing made that permanent, because the only thing
  // that could have produced the first frame was the request being skipped.
  //
  // It is safe to ask unconditionally because the ROUTE refuses to create: it
  // photographs a browser this agent already has and answers 409 when it has
  // none. The invariant that opening a panel never puts a Chrome window on
  // someone's screen lives there, where it cannot be forgotten by a caller,
  // rather than in this condition. The capture never navigates either, so it
  // cannot disturb what the Boo is doing.
  const refreshedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      refreshedForRef.current = null
      return
    }
    // Per AGENT, not once per opening: switching Boos in the chooser is asking to
    // see a different screen, and the frame behind it may be from another run.
    if (!selectedAgentId || refreshedForRef.current === selectedAgentId) return
    refreshedForRef.current = selectedAgentId
    void apiFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/screenshot/capture`, {
      method: 'POST',
      // A refusal is the ordinary answer for a Boo with no browser open, and it
      // leaves whatever is already on screen. Nothing to report: the operator
      // asked to look, not to capture.
    }).catch(() => undefined)
  }, [open, selectedAgentId])

  // Escape closes, through the shared layer rather than a listener on this
  // element. The dock is not focusable and never takes focus on open, so a
  // keydown handler bound to it only ever fired if the pointer had already put
  // focus inside; with focus still on the toolbar button that opened it, the
  // documented dismissal did nothing. Focus is deliberately NOT trapped: this
  // floats beside the graph rather than over it, and trapping would make Tab
  // feel broken on the canvas.
  useDismissableLayer({ active: open, level: 'popover', onEscape: onClose })

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
      {/* ── Chooser ── teams on top, that team's Boos beneath.
          One surface, two rows, because they are one question asked twice: which
          team, then which Boo. Atlas draws the whole fleet, and a flat row of
          every agent there is a row nobody can read; the team row cuts it to the
          handful that share a name. A team graph already answers the first half,
          so it passes no teams and only the faces render. */}
      {(teams.length > 1 || agents.length > 1) && (
        <div
          className="chooser-union"
          style={{
            alignSelf: 'center',
            // ONE-COLUMN GRID, on purpose. A grid column sizes to the widest
            // item, so the faces row grows with the number of Boos while the team
            // bar keeps its own width, and the faces row can never be narrower
            // than the bar above it. Flex could not do this without measuring one
            // row in JS and writing the result onto the other.
            //
            // No background, border or shadow HERE. Two rows each sized to their
            // own contents do not add up to a rectangle, so a card drawn around
            // the pair would have to take the width of the wider one and pad the
            // other out with dead margin either side. The edge that wraps them
            // both is drawn from their combined alpha instead: see
            // `.chooser-union`.
            display: 'grid',
            // Clips the bar's fillets when the two rows come out the same width.
            // See `.chooser-union`; the class sets this too, and it is repeated
            // here so the rule is visible where the shape is built.
            overflow: 'hidden',
            // minmax(0, ...) so the column can actually SHRINK. A bare
            // max-content column takes its widest item's ideal width and ignores
            // the max-width above it, so a fleet with more teams than fit ran the
            // bar straight out of the dock and past the pane's clip instead of
            // scrolling inside it.
            gridTemplateColumns: 'minmax(0, max-content)',
            justifyItems: 'center',
            maxWidth: '100%',
          }}
        >
          {teams.length > 1 && (
            <div
              className="chooser-bar"
              // THE TEAM BAR — its own shape, sized to its own tabs.
              //
              // It OVERLAPS the faces row rather than resting on it, by exactly
              // the corner radius the two share. Two rounded rectangles that
              // overlap merge into ONE silhouette, and that is what makes the
              // pair read as a single connected object at any relative width:
              // equal widths give a plain rounded card, a wider faces row gives a
              // bar seated into a pill with rounded shoulders either side.
              //
              // Butting them edge to edge instead would leave the bar's square
              // bottom corners overhanging the row's rounded top ones whenever
              // the two came out the same width. That is not the rare case: the
              // faces row floors at the bar's width, so every team with fewer
              // Boos than there are teams lands exactly there.
              style={{
                // Read by the fillet pseudo-elements, which have to sit at the
                // seam's height and cannot see these constants otherwise.
                ['--chooser-seam' as string]: `${SEAM_RADIUS}px`,
                ['--chooser-fillet' as string]: `${CHOOSER_FILLET}px`,
                width: 'max-content',
                maxWidth: '100%',
                // The guaranteed shoulder. A grid column sizes to an item's
                // MARGIN box, so this is what stops the row ever matching the bar.
                marginInline: MIN_SHOULDER,
                background: 'var(--surface)',
                // SQUARE at the bottom, and that is what makes the seam straight.
                // Round both shapes and their corner arcs run through the SAME
                // band of the overlap rather than one covering the other: at the
                // midpoint each is inset by r - sqrt(r^2 - (r/2)^2), so the union
                // pinches inward about 2px on each edge and the hairline traces
                // the dimple. Squaring these two corners makes the bar full width
                // for the whole overlap, so it covers the row's top arc outright.
                // (Sinking the bar by 2*CHOOSER_RADIUS would also work and costs
                // no height, but it buries the tabs deeper than the shape needs.)
                borderRadius: `${CHOOSER_RADIUS}px ${CHOOSER_RADIUS}px 0 0`,
                padding: 4,
                marginBottom: -SEAM_RADIUS,
                // Over the faces row, which is a LATER sibling. The overlap has
                // to be hidden by the bar rather than painted over it.
                position: 'relative',
                zIndex: 1,
              }}
            >
              <div
                role="tablist"
                aria-label="Choose a team"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0,
                  padding: 0,
                  // NO tinted ground behind the tabs, deliberately.
                  //
                  // A ground has to stop somewhere, and where it stopped it drew
                  // a hard grey-on-white edge across the full width of the bar:
                  // the one straight line in a shape built entirely to avoid
                  // them. Moving it did not help, because every position for it
                  // is a line. The selection is marked on the TAB instead, the
                  // same way the faces row marks the chosen Boo, which leaves the
                  // bar's white and the row's white a single unbroken sheet.
                  overflowX: 'auto',
                  scrollbarWidth: 'none',
                }}
              >
                {teams.map((team) => {
                  const active = team.id === selectedTeamId
                  return (
                    <button
                      key={team.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-label={team.name}
                      title={team.name}
                      tabIndex={open ? 0 : -1}
                      onClick={() => onSelectTeam(team.id)}
                      className="relative cursor-pointer transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                      style={{
                        display: 'grid',
                        placeItems: 'center',
                        flexShrink: 0,
                        minWidth: 30,
                        height: 24,
                        padding: '0 7px',
                        border: 'none',
                        fontSize: 14,
                        lineHeight: 1,
                        // The selected team carries its own fill, the same disc
                        // the faces row puts under the chosen Boo. Fill and
                        // opacity only: a scale would nudge its neighbours and
                        // make the row twitch as the selection moved along it.
                        background: active ? 'rgb(var(--primary-rgb) / 0.14)' : 'transparent',
                        borderRadius: 9,
                        opacity: active ? 1 : 0.5,
                      }}
                    >
                      <span aria-hidden style={{ fontSize: iconFontSize(team.icon) }}>
                        {team.icon}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Faces ── avatar only: each Boo already has its own colour and
              face, and a name beside every one would out-weigh the picture it
              sits above. The name is on hover and in the accessible name. */}
          <div
            // A tablist is only a tablist when it HAS tabs. On an empty team this
            // row holds one line of prose and no `role="tab"` at all, which trips
            // axe's aria-required-children and has a screen reader announce an
            // empty tab list over a message it may then drop.
            {...(agents.length > 0
              ? ({ role: 'tablist', 'aria-label': 'Choose an agent' } as const)
              : {})}
            style={{
              // Fills the grid column, which is the max of this row's own width
              // and the team bar's. That is what makes the bar a FLOOR rather
              // than a cap: the row grows past it as Boos are added, and settles
              // back onto it for a team with fewer Boos than there are teams.
              width: '100%',
              background: 'var(--surface)',
              // A rounded rectangle, evenly. The top two corners are the
              // shoulders either side of the bar and the bottom two are the
              // outer edge; tightening the top pair to move the join lower only
              // squares off the shoulders and leaves a flat ledge beside the bar.
              borderRadius: CHOOSER_RADIUS,
              display: 'flex',
              alignItems: 'center',
              // SAFE centre. A plain `center` in a scroll container pushes the
              // leading items to negative offsets once the row overflows, and a
              // scroll range starts at 0, so those Boos are clipped with no
              // scroll position that reveals them: unreachable, not just
              // off-screen. `safe` falls back to flex-start exactly when that
              // would happen.
              justifyContent: 'safe center',
              gap: 2,
              padding: 5,
              // Clears the bar's overlap, so the faces start below it instead of
              // under it. Without a bar there is nothing to clear.
              // Only the hairline overlap to clear now, so the faces sit
              // centred in the row instead of pushed off its top edge.
              paddingTop: teams.length > 1 ? 5 + SEAM_RADIUS : 5,
              overflowX: 'auto',
              scrollbarWidth: 'none',
            }}
          >
            {agents.length === 0 && (
              <span
                className="text-muted-foreground"
                style={{ fontSize: 11, padding: '6px 10px', whiteSpace: 'nowrap' }}
              >
                No Boos on this team.
              </span>
            )}
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
                  className="relative grid shrink-0 cursor-pointer place-items-center rounded-full transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
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
        {src && meta && meta.restored && (
          // WHEN. Only rendered when the answer is not "just now": a frame
          // restored from disk can be hours old, and shown plainly it is the
          // panel asserting that an idle Boo is browsing.
          //
          // The dock is otherwise chromeless on purpose. This is the exception
          // because it is not decoration: it is the difference between a view
          // and a claim.
          <span
            style={{
              position: 'absolute',
              left: 8,
              bottom: 8,
              zIndex: 1,
              fontSize: 10,
              lineHeight: 1.4,
              padding: '3px 7px',
              borderRadius: 999,
              color: 'var(--surface)',
              background: 'rgb(15 23 42 / 0.62)',
              backdropFilter: 'blur(4px)',
              pointerEvents: 'none',
              maxWidth: 'calc(100% - 16px)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Before the restart
          </span>
        )}
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
                : selectedAgent && !usesClawbooBrowser(selectedAgent)
                  ? // A DIFFERENT SILENCE, and the one that reads worst if it is
                    // not said out loud. This Boo runs somewhere with its own
                    // tools, so it can open a page through its own runtime and
                    // clawboo never sees it. Saying "hasn't opened a page" here
                    // asserts something false about a Boo that may be browsing
                    // right now, just not through us.
                    `${selectedAgent.name} runs on ${runtimeLabel(selectedAgent.runtime)} and browses with its own tools, so its screen is not visible here.`
                  : grant === 'missing'
                    ? 'No browser granted to this Boo.'
                    : // The honest empty state for a Boo that CAN be seen: the
                      // browser is granted and connected, and it simply has not
                      // opened anything.
                      'This Boo has not opened a page yet.'}
          </p>
        )}
      </div>
    </div>
  )
}
