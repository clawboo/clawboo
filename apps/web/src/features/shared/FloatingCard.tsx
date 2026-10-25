// A side card beside a chat (agent graph, files, team graph): a rounded,
// raised surface with a slim header (title, extra actions, maximize, close), or
// none, when its content draws its own top row.
//
// The container deliberately avoids transform / filter / backdrop-filter / mask:
// modals in this app are not portalled, and any of those would trap or clip a
// `position: fixed` descendant to the card's box.

import type { ReactNode } from 'react'
import { Maximize2, Minimize2, X, type LucideIcon } from 'lucide-react'
import { IconButton } from './Button'

/** Style for a resizable `Panel` / `Group` holding a card. Both clip to their
 *  box by default, which squares off the card's shadow at its rounded corners;
 *  the card itself still clips its own content. */
export const CARD_PANEL_STYLE = { overflow: 'visible' } as const

export function FloatingCard({
  title,
  icon: Icon,
  actions,
  maximized = false,
  onToggleMaximize,
  onClose,
  closeLabel,
  headerless = false,
  children,
  testId,
}: {
  title: ReactNode
  icon?: LucideIcon
  /** Extra header content, between the title and the window buttons. */
  actions?: ReactNode
  maximized?: boolean
  onToggleMaximize?: () => void
  onClose?: () => void
  /** Accessible name for the close button when `title` is not plain text. */
  closeLabel?: string
  /** No header row: the content draws its own top row and places
   *  `CardWindowButtons` in it. */
  headerless?: boolean
  children: ReactNode
  testId?: string
}) {
  return (
    <section
      data-testid={testId}
      aria-label={headerless && typeof title === 'string' ? title : undefined}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface"
      style={{ boxShadow: 'var(--shadow-floating)' }}
    >
      {!headerless && (
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5">
          {Icon ? (
            <Icon size={14} strokeWidth={2} aria-hidden className="text-muted-foreground" />
          ) : null}
          <h3 className="min-w-0 truncate text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
            {title}
          </h3>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {actions}
            <CardWindowButtons
              title={title}
              maximized={maximized}
              onToggleMaximize={onToggleMaximize}
              onClose={onClose}
              closeLabel={closeLabel}
            />
          </div>
        </header>
      )}
      <div className="relative min-h-0 flex-1">{children}</div>
    </section>
  )
}

/** A card's maximize and close buttons. `FloatingCard` draws them in its
 *  header; a headerless card's content places them in its own top row. */
export function CardWindowButtons({
  title,
  maximized = false,
  onToggleMaximize,
  onClose,
  closeLabel,
}: {
  title: ReactNode
  maximized?: boolean
  onToggleMaximize?: () => void
  onClose?: () => void
  closeLabel?: string
}) {
  return (
    <>
      {onToggleMaximize ? (
        <IconButton
          size="sm"
          label={maximized ? 'Restore' : 'Maximize'}
          onClick={onToggleMaximize}
          className="h-6 w-6 text-muted-foreground"
        >
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </IconButton>
      ) : null}
      {onClose ? (
        <IconButton
          size="sm"
          label={closeLabel ?? `Close ${typeof title === 'string' ? title.toLowerCase() : 'panel'}`}
          onClick={onClose}
          className="h-6 w-6 text-muted-foreground"
        >
          <X size={14} />
        </IconButton>
      ) : null}
    </>
  )
}

/** Header button that shows or hides one side card. Pressed = card open. */
export function PaneToggle({
  icon: Icon,
  label,
  open,
  onClick,
  testId,
}: {
  icon: LucideIcon
  label: string
  open: boolean
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={open}
      aria-label={open ? `Hide ${label}` : `Show ${label}`}
      title={open ? `Hide ${label}` : `Show ${label}`}
      onClick={onClick}
      className={[
        'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none p-0 transition-colors duration-150',
        open
          ? 'bg-foreground/[0.07] text-foreground'
          : 'bg-transparent text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
      ].join(' ')}
    >
      <Icon size={15} strokeWidth={2} aria-hidden />
    </button>
  )
}
