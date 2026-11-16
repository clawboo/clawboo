import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useEmbedTitlebar } from '@/features/embedder/embedTitlebar'
import { useInboxCount } from '@/features/inbox/useInboxCount'
import { useInSettingsModal } from '@/features/settings/settingsModalContext'
import { useViewStore } from '@/stores/view'
import { openPhoneNav, usePhoneLayout, usePhoneNav } from './phoneLayout'
import { closePeek, openPeek, schedulePeekHide } from './sidebarPeek'

/** The sidebar toggle. Open, it sits in the agent column's top row (or the team
 *  rail's, when there is no column). Collapsed, it moves to the start of the
 *  current view's header (see `CollapsedSidebarToggle`). Under the slim top bar
 *  it lives in the bar instead, open or collapsed (see `EmbedTitlebar`).
 *  `compact` is the bar's smaller size. */
export function SidebarToggle({
  collapsed,
  onClick,
  onMouseEnter,
  onMouseLeave,
  className = '',
  compact = false,
}: {
  collapsed: boolean
  onClick: () => void
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void
  onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void
  className?: string
  compact?: boolean
}) {
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose
  // The Inbox badge sits in the sidebar, so while the sidebar is away (collapsed, or
  // a closed drawer on a phone) this says there is something to see.
  const inbox = useInboxCount()
  const showInbox = collapsed && inbox > 0
  return (
    <button
      type="button"
      data-testid="sidebar-toggle"
      aria-label={showInbox ? `${label}, ${inbox} in your inbox` : label}
      aria-expanded={!collapsed}
      title={`${label} (⌘\\)`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={[
        compact
          ? 'relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 text-foreground/60 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground'
          : 'relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent p-0 text-foreground/45 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground/80',
        className,
      ].join(' ')}
    >
      <Icon size={compact ? 16 : 17} strokeWidth={compact ? 2 : 1.9} aria-hidden />
      {showInbox ? (
        <span
          data-testid="sidebar-toggle-inbox-dot"
          aria-hidden
          className="absolute right-1 top-1 size-1.5 rounded-full bg-primary-solid"
        />
      ) : null}
    </button>
  )
}

/** The expand toggle a view puts at the start of its header. Renders only while
 *  the sidebar is collapsed (and never inside the Settings modal, which reuses
 *  the panels' headers). Hovering it peeks the sidebar; clicking docks it.
 *  At phone width the sidebar never docks, so it always renders there, and a
 *  tap opens the sidebar as a drawer over the view. Under the slim top bar,
 *  wider than a phone, the bar's own toggle does all of this instead. */
export function CollapsedSidebarToggle({ className }: { className?: string }) {
  const collapsed = useViewStore((s) => s.columnCollapsed)
  const phone = usePhoneLayout()
  const drawerOpen = usePhoneNav((s) => s.open)
  const inSettingsModal = useInSettingsModal()
  const embedBar = useEmbedTitlebar()
  if (inSettingsModal) return null
  if (embedBar && !phone) return null
  if (phone) {
    return <SidebarToggle collapsed={!drawerOpen} className={className} onClick={openPhoneNav} />
  }
  if (!collapsed) return null
  return (
    <SidebarToggle
      collapsed
      className={className}
      onClick={() => {
        closePeek()
        useViewStore.getState().setColumnCollapsed(false)
      }}
      onMouseEnter={openPeek}
      onMouseLeave={schedulePeekHide}
    />
  )
}
