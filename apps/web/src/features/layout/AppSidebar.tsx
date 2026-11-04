import { useCallback, useEffect, useRef, useState } from 'react'
import { TeamSidebar } from '@/features/layout/TeamSidebar'
import { AgentListColumn } from '@/features/layout/AgentListColumn'
import { ErrorBoundary } from '@/features/shared/ErrorBoundary'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import {
  closePhoneNav,
  isPhoneLayout,
  togglePhoneNav,
  usePhoneLayout,
  usePhoneNav,
} from '@/features/layout/phoneLayout'
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
/** With no agent column (Boo Zero view), a drag this far left collapses the rail. */
const RAIL_COLLAPSE_DRAG = -40
const KEY_STEP = 16

// ─── Column body ─────────────────────────────────────────────────────────────

/** The agent column at `width`. Narrower than its natural width the content
 *  keeps its natural layout and is clipped, with a fade at the right edge that
 *  deepens the narrower it gets. The fade is an overlay, not a CSS mask: a mask
 *  would also clip the column's (unportalled) modals to the column's box. */
function ColumnBody({ width, bordered }: { width: number; bordered: boolean }) {
  const narrow = width < SIDEBAR_NATURAL_WIDTH
  const fade = Math.min(48, Math.max(0, (SIDEBAR_NATURAL_WIDTH - width) * 1.4))
  return (
    <div
      className={[
        'relative h-full shrink-0 bg-surface',
        bordered ? 'border-r border-border' : '',
      ].join(' ')}
      style={{ width }}
    >
      <div className="h-full overflow-hidden">
        <div className="h-full" style={{ width: narrow ? SIDEBAR_NATURAL_WIDTH : '100%' }}>
          <ErrorBoundary
            variant="compact"
            label="the agent sidebar"
            fallbackClassName="h-full w-full bg-surface"
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
            background: 'linear-gradient(to right, rgb(var(--surface-rgb) / 0), var(--surface))',
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
}: {
  peek: boolean
  showToggle: boolean
  toggleAnchor?: PeekAnchor | null
}) {
  return (
    <ErrorBoundary
      variant="compact"
      label="the team sidebar"
      fallbackClassName="h-full w-[60px] shrink-0 border-r border-border bg-background"
    >
      <TeamSidebar peek={peek} showToggle={showToggle} toggleAnchor={toggleAnchor} />
    </ErrorBoundary>
  )
}

// ─── Phone drawer ────────────────────────────────────────────────────────────

/** The sidebar at phone width: the rail and the column laid over the content
 *  from the left edge, behind a scrim, opened from the toggle at the start of
 *  the view's header. Escape or a tap on the scrim closes it, and so does moving
 *  to another view (see AppSidebar). Kept mounted while closed, inert and out of
 *  sight, so the column keeps its search and scroll between openings. */
function PhoneDrawer({ showColumn }: { showColumn: boolean }) {
  const open = usePhoneNav((s) => s.open)
  const panelRef = useRef<HTMLDivElement>(null)

  useDismissableLayer({ active: open, level: 'dialog', onEscape: closePhoneNav })

  // Focus goes into the drawer as it opens, so a keyboard or a screen reader
  // starts there rather than behind the scrim.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

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
          paddingTop: 'var(--clawboo-titlebar-inset, 0px)',
          background: 'var(--background)',
          boxShadow: open ? 'var(--shadow-overlay)' : 'none',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          visibility: open ? 'visible' : 'hidden',
          transition: open
            ? 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1), visibility 0s'
            : 'transform 160ms ease, visibility 0s linear 160ms',
        }}
      >
        <Rail peek={false} showToggle={!showColumn} />
        {/* The column's natural width: a width dragged on a wide window would
            leave no room beside the drawer to tap it closed. */}
        {showColumn && <ColumnBody width={SIDEBAR_NATURAL_WIDTH} bordered />}
      </div>
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

  // ── Phone drawer: closed by a move to another view, and by a wide window ───
  useEffect(() => {
    closePhoneNav()
  }, [viewMode])
  useEffect(() => {
    if (!phone) closePhoneNav()
  }, [phone])

  // ── Render ─────────────────────────────────────────────────────────────────
  if (phone) return <PhoneDrawer showColumn={showColumn} />

  if (isCollapsed) {
    // Not mounted mid-drag: the drag preview collapses and expands live.
    if (dragging) return null
    return (
      <div
        ref={setPeekPanel}
        data-testid="sidebar-peek"
        inert={!peek || undefined}
        onMouseEnter={clearPeekHide}
        onMouseLeave={schedulePeekHide}
        className="fixed inset-y-0 z-[58] flex"
        style={{
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
        <Rail peek showToggle toggleAnchor={anchor} />
        {showColumn && <ColumnBody width={width} bordered />}
      </div>
    )
  }

  return (
    <div className="relative flex h-full shrink-0" data-testid="app-sidebar">
      <Rail peek={false} showToggle={!showColumn} />
      {showColumn && <ColumnBody width={width} bordered />}
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
