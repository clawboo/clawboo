import { useCallback, useEffect, useRef, useState } from 'react'
import { TeamSidebar } from '@/features/layout/TeamSidebar'
import { AgentListColumn } from '@/features/layout/AgentListColumn'
import { AccountBar } from '@/features/layout/AccountBar'
import { useEmbedTitlebar } from '@/features/embedder/embedTitlebar'
import { ErrorBoundary } from '@/features/shared/ErrorBoundary'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { useFocusTrap } from '@/features/shared/useFocusTrap'
import { useSettingsModalStore } from '@/stores/settingsModal'
import {
  closePhoneNav,
  isPhoneLayout,
  togglePhoneNav,
  usePhoneLayout,
  usePhoneNav,
} from '@/features/layout/phoneLayout'
import { RAIL_COLLAPSE_DRAG, RAIL_WIDTH, SHEET_RADIUS } from '@/features/layout/railMetrics'
import {
  clearPeekHide,
  closePeek,
  notePointer,
  schedulePeekHide,
  setPeekPanel,
  useSidebarPeek,
  type PeekAnchor,
} from '@/features/layout/sidebarPeek'
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_NATURAL_WIDTH,
  clampSidebarWidth,
  useViewStore,
} from '@/stores/view'

/** Dragging the column narrower than this (raw, before clamping) collapses it. */
const COLLAPSE_BELOW = 120
const KEY_STEP = 16

/** The slim top bar's height in px, for a layer that starts under it. Zero
 *  without the bar. */
function embedTitlebarHeight(): number {
  return document.querySelector('[data-embed-titlebar]')?.getBoundingClientRect().height ?? 0
}

// ─── Column body ─────────────────────────────────────────────────────────────

/** The agent column at `width`. Narrower than its natural width the content
 *  keeps its natural layout and is clipped, with a fade at the right edge that
 *  deepens the narrower it gets. The fade is an overlay, not a CSS mask: a mask
 *  would also clip the column's (unportalled) modals to the column's box.
 *
 *  `sheet`: under the slim top bar, the column opens the sheet everything right
 *  of the rail sits on. Its top and left edges carry the divider line and meet
 *  in a rounded corner, and the page beside it carries the top line on (see
 *  App.tsx), so the bar and the rail read as a frame around one sheet. */
function ColumnBody({
  width,
  bordered,
  sheet = false,
}: {
  width: number
  bordered: boolean
  sheet?: boolean
}) {
  const narrow = width < SIDEBAR_NATURAL_WIDTH
  const fade = Math.min(48, Math.max(0, (SIDEBAR_NATURAL_WIDTH - width) * 1.4))
  return (
    <div
      data-testid="agent-column-body"
      className={[
        'relative h-full shrink-0 bg-frame-column',
        bordered ? 'border-r border-border' : '',
        sheet ? 'border-l border-t' : '',
      ].join(' ')}
      style={{ width, ...(sheet ? { borderTopLeftRadius: SHEET_RADIUS } : {}) }}
    >
      {/* Clips the column's own fill to the corner, inside the 1px line. */}
      <div
        className="h-full overflow-hidden"
        style={sheet ? { borderTopLeftRadius: SHEET_RADIUS - 1 } : undefined}
      >
        <div className="h-full" style={{ width: narrow ? SIDEBAR_NATURAL_WIDTH : '100%' }}>
          <ErrorBoundary
            variant="compact"
            label="the agent sidebar"
            fallbackClassName="h-full w-full bg-frame-column"
          >
            <AgentListColumn />
          </ErrorBoundary>
        </div>
      </div>
      {fade > 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-[1]"
          style={{
            width: fade,
            background:
              'linear-gradient(to right, rgb(var(--frame-column-rgb) / 0), var(--frame-column))',
          }}
        />
      )}
    </div>
  )
}

function Rail({
  peek,
  showToggle,
  toggleAnchor,
  edge,
}: {
  peek: boolean
  showToggle: boolean
  toggleAnchor?: PeekAnchor | null
  edge: boolean
}) {
  return (
    <ErrorBoundary
      variant="compact"
      label="the team sidebar"
      fallbackClassName={['h-full shrink-0 bg-frame', edge ? 'border-r border-border' : ''].join(
        ' ',
      )}
      fallbackStyle={{ width: RAIL_WIDTH }}
    >
      <TeamSidebar peek={peek} showToggle={showToggle} toggleAnchor={toggleAnchor} edge={edge} />
    </ErrorBoundary>
  )
}

/** The whole sidebar: the team rail and the agent column side by side, and the
 *  account bar across the bottom of both, on the frame colour. The same frame
 *  docks beside the content, lays over it in the collapsed sidebar's peek, and
 *  slides in as the phone drawer. Without the agent column (Boo Zero's view) the
 *  account bar stacks to fit the rail. */
function SidebarFrame({
  showColumn,
  columnWidth,
  peek,
  showToggle,
  toggleAnchor,
  sheet = false,
  docked = false,
}: {
  showColumn: boolean
  columnWidth: number
  peek: boolean
  showToggle: boolean
  toggleAnchor?: PeekAnchor | null
  /** Under the slim top bar: the column (or, docked without one, the page)
   *  draws the line beside the rail, with the rounded corner. */
  sheet?: boolean
  docked?: boolean
}) {
  const railEdge = !(sheet && (showColumn || docked))
  return (
    // An explicit width: without it the account bar's text would widen the
    // sidebar past the rail and the column instead of truncating.
    <div
      className="flex h-full min-h-0 flex-col bg-frame"
      data-testid="sidebar-frame"
      style={{ width: RAIL_WIDTH + (showColumn ? columnWidth : 0) }}
    >
      <div className="flex min-h-0 flex-1">
        <Rail peek={peek} showToggle={showToggle} toggleAnchor={toggleAnchor} edge={railEdge} />
        {showColumn && <ColumnBody width={columnWidth} bordered sheet={sheet} />}
      </div>
      <div className="shrink-0 border-r border-border p-2" data-testid="account-strip">
        <ErrorBoundary
          variant="compact"
          label="the account bar"
          fallbackClassName="h-12 w-full rounded-xl bg-surface"
        >
          <AccountBar compact={!showColumn} />
        </ErrorBoundary>
      </div>
    </div>
  )
}

// ─── Phone drawer ────────────────────────────────────────────────────────────

/** Holds Tab inside the open drawer and hands focus back to whatever opened it
 *  on close. Its own component, mounted only while the drawer is open: the trap
 *  works for as long as it is mounted, and the drawer itself never unmounts. */
function DrawerFocusTrap({ panelRef }: { panelRef: React.RefObject<HTMLDivElement | null> }) {
  useFocusTrap(panelRef, null)
  return null
}

/** The sidebar at phone width: the rail and the column laid over the content
 *  from the left edge, behind a scrim, opened from the toggle at the start of
 *  the view's header. Escape or a tap on the scrim closes it, and so does moving
 *  to another view or opening Settings (see AppSidebar). Kept mounted while
 *  closed, inert and out of sight, so the column keeps its search and scroll
 *  between openings. */
function PhoneDrawer({ showColumn, embedBar }: { showColumn: boolean; embedBar: boolean }) {
  // Settings opens over the whole app, so the drawer steps aside in the same
  // render: its trap lets go of focus before the modal's takes it, and the modal
  // then hands focus back to the header toggle rather than into a closed drawer.
  const settingsOpen = useSettingsModalStore((s) => s.open)
  const open = usePhoneNav((s) => s.open) && !settingsOpen
  const panelRef = useRef<HTMLDivElement>(null)

  useDismissableLayer({ active: open, level: 'dialog', onEscape: closePhoneNav })

  return (
    <>
      {/* A tap beside the drawer lands here and closes it. It is the scrim's own
          click, not an outside-press, so the tap never also reaches whatever
          sits under the scrim. */}
      <div
        aria-hidden
        data-testid="sidebar-drawer-scrim"
        onClick={closePhoneNav}
        className="fixed inset-0 z-[57] bg-black/40"
        style={{
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 160ms ease',
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        tabIndex={-1}
        inert={!open || undefined}
        data-testid="sidebar-drawer"
        className="fixed inset-y-0 left-0 z-[58] flex outline-none"
        style={{
          // Under the slim top bar it starts below the bar, so the bar stays the
          // window's to drag. Otherwise it pads past the embedder's strip.
          ...(embedBar
            ? { top: 'var(--clawboo-titlebar-inset, 0px)' }
            : { paddingTop: 'var(--clawboo-titlebar-inset, 0px)' }),
          background: 'var(--frame)',
          boxShadow: open ? 'var(--shadow-overlay)' : 'none',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          // Closed, it is off screen and `inert`, which keeps it out of the tab
          // order and the accessibility tree, so visibility never changes. A
          // hidden-to-visible flip would start a visibility transition on every
          // `transition-all` control inside, leaving it hidden, and unfocusable,
          // on the frame where the focus trap moves focus in.
          transition: open
            ? 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)'
            : 'transform 160ms ease',
        }}
      >
        {/* The column's natural width: a width dragged on a wide window would
            leave no room beside the drawer to tap it closed. */}
        <SidebarFrame
          showColumn={showColumn}
          columnWidth={SIDEBAR_NATURAL_WIDTH}
          peek={false}
          showToggle={!showColumn}
          sheet={embedBar}
        />
      </div>
      {open && <DrawerFocusTrap panelRef={panelRef} />}
    </>
  )
}

// ─── AppSidebar ──────────────────────────────────────────────────────────────

/** The left sidebar: team rail + agent column. Drag the right edge to resize;
 *  drag well past the minimum (or press the toggle, or ⌘\) to collapse both
 *  columns. Collapsed, nothing is left on screen: the expand toggle moves to the
 *  start of the view's header. Hovering it lays the sidebar over the content
 *  right where it normally sits, hiding again when the pointer leaves; clicking
 *  it docks the sidebar back. */
export function AppSidebar() {
  const collapsed = useViewStore((s) => s.columnCollapsed)
  const storedWidth = useViewStore((s) => s.sidebarWidth)
  // Boo Zero's view has no agent column, only the rail.
  const showColumn = useViewStore((s) => s.viewMode.type !== 'booZero')
  // At phone width the sidebar is a drawer over the content instead.
  const phone = usePhoneLayout()
  const viewMode = useViewStore((s) => s.viewMode)
  // An app that shows the dashboard in its own window asked for the slim top bar.
  const embedBar = useEmbedTitlebar()

  const [drag, setDrag] = useState<{ width: number; collapsed: boolean } | null>(null)
  const width = drag?.width ?? storedWidth
  const isCollapsed = drag?.collapsed ?? collapsed
  const dragging = drag !== null

  // ── Resize drag ────────────────────────────────────────────────────────────
  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startX = e.clientX
      const startWidth = showColumn ? storedWidth : 0
      let last = { width: storedWidth, collapsed: false }
      setDrag(last)
      const prevCursor = document.body.style.cursor
      const prevSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: PointerEvent) => {
        const raw = startWidth + (ev.clientX - startX)
        const collapse = showColumn ? raw < COLLAPSE_BELOW : raw < RAIL_COLLAPSE_DRAG
        last = {
          width: collapse || !showColumn ? last.width : clampSidebarWidth(raw),
          collapsed: collapse,
        }
        setDrag(last)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = prevSelect
        const store = useViewStore.getState()
        // A collapse keeps the width from before the drag, so expanding again
        // returns to it rather than to the minimum the drag passed through.
        if (last.collapsed) store.setColumnCollapsed(true)
        else if (showColumn) store.setSidebarWidth(last.width)
        setDrag(null)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [showColumn, storedWidth],
  )

  const onHandleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const store = useViewStore.getState()
      if (e.key === 'Enter') {
        e.preventDefault()
        store.setColumnCollapsed(true)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (!showColumn || storedWidth <= SIDEBAR_MIN_WIDTH) store.setColumnCollapsed(true)
        else store.setSidebarWidth(storedWidth - KEY_STEP)
      } else if (e.key === 'ArrowRight' && showColumn) {
        e.preventDefault()
        store.setSidebarWidth(storedWidth + KEY_STEP)
      }
    },
    [showColumn, storedWidth],
  )

  // ── ⌘\ / Ctrl+\ toggles the sidebar (the drawer, at phone width) ─────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '\\' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        if (isPhoneLayout()) togglePhoneNav()
        else useViewStore.getState().toggleColumnCollapsed()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Hover peek (collapsed only) ────────────────────────────────────────────
  const peek = useSidebarPeek((s) => s.peek)
  const anchor = useSidebarPeek((s) => s.anchor)

  useEffect(() => {
    if (!collapsed) {
      closePeek()
      return
    }
    const onMove = (e: MouseEvent) => notePointer({ x: e.clientX, y: e.clientY })
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget === null) notePointer(null)
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('mouseout', onOut)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseout', onOut)
    }
  }, [collapsed])
  useEffect(() => clearPeekHide, [])

  // ── Phone drawer: closed by a move to another view, by Settings opening ────
  // (so it does not come back over the page when Settings closes), and by a
  // wide window.
  const settingsOpen = useSettingsModalStore((s) => s.open)
  useEffect(() => {
    closePhoneNav()
  }, [viewMode])
  useEffect(() => {
    if (settingsOpen) closePhoneNav()
  }, [settingsOpen])
  useEffect(() => {
    if (!phone) closePhoneNav()
  }, [phone])

  // ── Render ─────────────────────────────────────────────────────────────────
  if (phone) return <PhoneDrawer showColumn={showColumn} embedBar={embedBar} />

  if (isCollapsed) {
    // Not mounted mid-drag: the drag preview collapses and expands live.
    if (dragging) return null
    // Under the slim top bar the peek starts below it, and the bar's own toggle
    // (above the peek) docks the sidebar, so the peek shows none of its own.
    const barHeight = embedBar ? embedTitlebarHeight() : 0
    const peekAnchor = anchor ? { left: anchor.left, top: anchor.top - barHeight } : null
    return (
      <div
        ref={setPeekPanel}
        data-testid="sidebar-peek"
        inert={!peek || undefined}
        onMouseEnter={clearPeekHide}
        onMouseLeave={schedulePeekHide}
        className="fixed inset-y-0 z-[58] flex"
        style={{
          ...(embedBar ? { top: 'var(--clawboo-titlebar-inset, 0px)' } : {}),
          // Exactly where the docked sidebar sits, laid over the content.
          // Its toggle lands on the header toggle that opened it, so a
          // click there docks the sidebar and pushes the content over.
          left: peek ? 0 : -12,
          opacity: peek ? 1 : 0,
          visibility: peek ? 'visible' : 'hidden',
          pointerEvents: peek ? 'auto' : 'none',
          boxShadow: 'var(--shadow-overlay)',
          transition: peek
            ? 'opacity 140ms ease, left 180ms cubic-bezier(0.32, 0.72, 0, 1), visibility 0s'
            : 'opacity 120ms ease, left 140ms ease, visibility 0s linear 140ms',
        }}
      >
        <SidebarFrame
          showColumn={showColumn}
          columnWidth={width}
          peek
          showToggle={!embedBar}
          toggleAnchor={peekAnchor}
          sheet={embedBar}
        />
      </div>
    )
  }

  return (
    <div className="relative flex h-full shrink-0" data-testid="app-sidebar">
      <SidebarFrame
        showColumn={showColumn}
        columnWidth={width}
        peek={false}
        showToggle={!showColumn && !embedBar}
        sheet={embedBar}
        docked
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={showColumn ? width : undefined}
        aria-valuemin={showColumn ? SIDEBAR_MIN_WIDTH : undefined}
        tabIndex={0}
        data-testid="sidebar-resize-handle"
        onPointerDown={startDrag}
        onDoubleClick={() => useViewStore.getState().setSidebarWidth(SIDEBAR_NATURAL_WIDTH)}
        onKeyDown={onHandleKeyDown}
        title="Drag to resize, double-click to reset"
        className="group absolute inset-y-0 z-20 flex cursor-col-resize justify-center outline-none"
        style={{ right: -4, width: 8 }}
      >
        <span
          aria-hidden
          className={[
            'h-full w-[2px] transition-colors duration-150',
            dragging
              ? 'bg-primary/60'
              : 'bg-transparent group-hover:bg-foreground/15 group-focus-visible:bg-primary/60',
          ].join(' ')}
        />
      </div>
    </div>
  )
}
