import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useInSettingsModal } from '@/features/settings/settingsModalContext'
import { useViewStore } from '@/stores/view'
import { closePeek, openPeek, schedulePeekHide } from './sidebarPeek'

/** The sidebar toggle. Open, it sits in the agent column's top row (or the team
 *  rail's, when there is no column). Collapsed, it moves to the start of the
 *  current view's header (see `CollapsedSidebarToggle`). */
export function SidebarToggle({
  collapsed,
  onClick,
  onMouseEnter,
  onMouseLeave,
  className = '',
}: {
  collapsed: boolean
  onClick: () => void
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void
  onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void
  className?: string
}) {
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose
  return (
    <button
      type="button"
      data-testid="sidebar-toggle"
      aria-label={label}
      aria-expanded={!collapsed}
      title={`${label} (⌘\\)`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={[
        'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent p-0 text-foreground/45 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground/80',
        className,
      ].join(' ')}
    >
      <Icon size={17} strokeWidth={1.9} aria-hidden />
    </button>
  )
}

/** The expand toggle a view puts at the start of its header. Renders only while
 *  the sidebar is collapsed (and never inside the Settings modal, which reuses
 *  the panels' headers). Hovering it peeks the sidebar; clicking docks it. */
export function CollapsedSidebarToggle({ className }: { className?: string }) {
  const collapsed = useViewStore((s) => s.columnCollapsed)
  const inSettingsModal = useInSettingsModal()
  if (!collapsed || inSettingsModal) return null
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
