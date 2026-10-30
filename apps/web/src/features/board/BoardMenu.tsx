// A small menu the board opens from a button: a card's "more" actions, the
// agents a task can go to, the view picker. Portalled with fixed positioning,
// because lanes and cells clip, and registered on the dismissable-layer stack
// (Escape and a press outside close it) with the APG menu keys.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, MoreHorizontal } from 'lucide-react'

import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { useMenuKeyboard } from '@/features/shared/useMenuKeyboard'

export interface BoardMenuItem {
  key: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  /** Starts a group under this heading. */
  group?: string
  /** A hairline above it, setting it apart from the items before. */
  separator?: boolean
  /** A choice menu: the current choice carries a check. */
  checked?: boolean
  /** A key that does the same, shown at the end of the row. */
  keycap?: string
  testId?: string
}

const GAP = 4
const EDGE = 8

export function BoardMenu({
  anchor,
  label,
  items,
  onClose,
  width = 200,
  align = 'end',
  multi = false,
  testId,
}: {
  /** The button that opened it: the menu opens below it, or above when there
   *  is no room underneath. */
  anchor: HTMLElement
  label: string
  items: BoardMenuItem[]
  onClose: () => void
  width?: number
  /** Which edge of the button the menu lines up with. */
  align?: 'start' | 'end'
  /** Several choices at once (a filter): checked items are checkboxes, and
   *  picking one leaves the menu open for the next. */
  multi?: boolean
  testId?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { itemProps, menuKeyDown } = useMenuKeyboard(items.length, onClose)
  const choice = items.some((i) => i.checked !== undefined)

  useDismissableLayer({
    active: true,
    level: 'popover',
    onEscape: onClose,
    contains: (t) => !!ref.current?.contains(t) || anchor.contains(t),
    onPressOutside: onClose,
  })

  const rect = anchor.getBoundingClientRect()
  const [top, setTop] = useState(rect.bottom + GAP)
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    const r = anchor.getBoundingClientRect()
    setTop(
      r.bottom + GAP + h > window.innerHeight - EDGE
        ? Math.max(EDGE, r.top - GAP - h)
        : r.bottom + GAP,
    )
  }, [anchor])
  const wanted = align === 'end' ? rect.right - width : rect.left
  const left = Math.min(Math.max(EDGE, wanted), window.innerWidth - width - EDGE)

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={menuKeyDown}
      data-testid={testId}
      className="board-pop-in board-ink-focus fixed z-[100] overflow-hidden rounded-xl border border-border bg-popover py-1"
      style={{ top, left, width, boxShadow: 'var(--shadow-floating)' }}
    >
      {items.map((item, i) => (
        <div key={item.key} role="none">
          {item.separator ? <div role="none" className="mx-3 my-1 border-t border-border" /> : null}
          {item.group ? (
            <div
              role="presentation"
              className={`px-3 pb-1 text-xs font-medium text-muted-foreground ${i === 0 ? 'pt-1.5' : 'mt-1 pt-2'}`}
            >
              {item.group}
            </div>
          ) : null}
          <button
            type="button"
            role={
              item.checked === undefined ? 'menuitem' : multi ? 'menuitemcheckbox' : 'menuitemradio'
            }
            aria-checked={item.checked === undefined ? undefined : item.checked}
            data-testid={item.testId}
            aria-keyshortcuts={item.keycap}
            {...itemProps(i)}
            onClick={() => {
              if (!(multi && item.checked !== undefined)) onClose()
              item.onSelect()
            }}
            className="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-compact text-foreground transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:outline-none"
          >
            {choice ? (
              <span className="flex w-3.5 shrink-0 justify-center">
                {item.checked ? <Check size={14} strokeWidth={2} aria-hidden /> : null}
              </span>
            ) : null}
            {item.icon ? (
              <span aria-hidden className="flex shrink-0 text-muted-foreground">
                {item.icon}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.keycap ? <Keycap hidden>{item.keycap}</Keycap> : null}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

/** A key, as the board shows it beside a control or in a tooltip. `hidden`
 *  keeps it out of the control's name when `aria-keyshortcuts` already says it. */
export function Keycap({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return (
    <kbd
      aria-hidden={hidden || undefined}
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-border px-1 text-micro font-medium text-muted-foreground"
      style={{ fontFamily: 'inherit' }}
    >
      {children}
    </kbd>
  )
}

/** The round "more" button that opens a card's menu. It owns whether the menu
 *  is open; `items` is read when it opens and gets the button, which an action
 *  hands focus back to (the menu itself is portalled outside the card). */
export function MoreMenuButton({
  label,
  items,
  disabled,
  testId,
}: {
  /** What the menu is for, said by the button and the menu. */
  label: string
  items: (opener: HTMLElement) => BoardMenuItem[]
  disabled?: boolean
  testId?: string
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        title="More"
        onClick={(e) => {
          if (disabled) return
          const el = e.currentTarget
          setAnchor((a) => (a ? null : el))
        }}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 aria-disabled:cursor-default aria-disabled:opacity-50"
      >
        <MoreHorizontal size={14} strokeWidth={2} aria-hidden />
      </button>
      {anchor ? (
        <BoardMenu
          anchor={anchor}
          label={label}
          items={items(anchor)}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </>
  )
}
