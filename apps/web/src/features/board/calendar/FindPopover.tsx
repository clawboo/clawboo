// The Board's Find popover: a search field over the tasks and routines on the
// board, results grouped by where they sit (the range shown, before it, after
// it, then routines). The field is a combobox and keeps focus the whole time: the arrows
// walk the results, Enter shows a task on the board, Shift+Enter opens it, and a
// routine always opens. Matching and grouping live in findModel; this file only
// draws them and handles the keys.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Repeat, Search, X } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { useFocusTrap } from '@/features/shared/useFocusTrap'
import type { BoardTask } from '@/lib/boardClient'

import {
  FIND_LIMIT,
  findGroups,
  type FindResult,
  type FindScope,
  type FindTaskResult,
} from './findModel'
import { StatusGlyph, glyphKindOf } from '../StatusGlyph'
import { useAnchoredPosition } from './useAnchoredPosition'

const WIDTH = 360
const HEIGHT = 420

export interface FindPopoverProps {
  anchor: HTMLElement
  /** Every match for a query, best first. */
  search: (query: string) => FindResult[]
  /** What the board shows, which names the sections. */
  scope: FindScope
  /** Whether routines can be found: the All view draws no runs to find them by. */
  findsRoutines: boolean
  /** The name of the column a task is drawn in. */
  columnName: (column: string) => string
  /** The day a task sits on, as the row shows it: "Today", "Oct 12". */
  dayLabel: (at: number | null) => string
  /** The agent whose Boo the row shows. */
  ownerOf: (task: BoardTask) => string | null
  agentName: (agentId: string) => string | null
  onPick: (result: FindResult, how: 'reveal' | 'open') => void
  onClose: () => void
}

/** Why a task matched, when it was not on its title. */
function matchNote(
  r: FindTaskResult,
  owner: string | null,
  agentName: (agentId: string) => string | null,
): string | null {
  switch (r.matchedOn) {
    case 'agent': {
      const name = owner ? agentName(owner) : null
      return name ? `Agent: ${name}` : 'Agent'
    }
    case 'description':
      return 'In the details'
    case 'id':
      return 'Task id'
    default:
      return null
  }
}

/** A result's identity, which outlives its place in the list. */
const keyOf = (r: FindResult) => `${r.kind}:${r.id}`

export function FindPopover({
  anchor,
  search,
  scope,
  findsRoutines,
  columnName,
  dayLabel,
  ownerOf,
  agentName,
  onPick,
  onClose,
}: FindPopoverProps) {
  const baseId = useId()
  const listId = `${baseId}-list`
  const hintId = `${baseId}-hint`
  const optionId = (i: number) => `${baseId}-option-${i}`
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pos = useAnchoredPosition(anchor, true, WIDTH, HEIGHT)
  const [query, setQuery] = useState('')
  // The highlighted result, by identity: the board can refresh under an open
  // popover and reorder or shorten the list, and Enter must still pick what is
  // highlighted. Null, or a result that has gone, means the first row.
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const results = useMemo(() => search(query), [search, query])
  const groups = useMemo(() => findGroups(results.slice(0, FIND_LIMIT), scope), [results, scope])
  // The order the arrows walk is the order drawn, which groups by where a result
  // sits, so it can differ from the ranking.
  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const keyedIndex = activeKey == null ? -1 : ordered.findIndex((r) => keyOf(r) === activeKey)
  const activeIndex = ordered.length === 0 ? -1 : Math.max(0, keyedIndex)
  const activeResult = activeIndex >= 0 ? ordered[activeIndex] : undefined
  const trimmed = query.trim()

  useDismissableLayer({
    active: true,
    level: 'popover',
    onEscape: onClose,
    contains: (t) => !!panelRef.current?.contains(t) || anchor.contains(t),
    onPressOutside: onClose,
  })

  // The field takes focus once the popover is placed (its first frame renders
  // nothing). The trap comes after it, so it finds focus inside and leaves it.
  const placed = pos != null
  useEffect(() => {
    if (placed) inputRef.current?.focus()
  }, [placed])
  useFocusTrap(panelRef, placed, inputRef)

  // The active row stays in view, including the first one when a new query
  // replaces a list that was scrolled. Only a new query or a move of the
  // highlight scrolls: a read of the board redraws the list, and must not pull
  // back someone reading further down it. jsdom has no scrollIntoView.
  useEffect(() => {
    if (activeIndex < 0) return
    document
      .getElementById(`${baseId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' })
    // `query` stands for a new list; the list itself is left out on purpose.
  }, [baseId, activeIndex, activeKey, query])

  function changeQuery(next: string) {
    setQuery(next)
    setActiveKey(null)
  }

  function setActive(i: number) {
    const r = ordered[i]
    if (r) setActiveKey(keyOf(r))
  }

  function pick(r: FindResult, open: boolean) {
    onPick(r, r.kind === 'routine' || open ? 'open' : 'reveal')
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = ordered.length
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (n === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + n) % n)
    } else if (e.key === 'Enter' && activeResult) {
      e.preventDefault()
      pick(activeResult, e.shiftKey)
    }
  }

  if (!pos) return null
  const more = results.length - FIND_LIMIT
  const label = findsRoutines ? 'Find a task, an agent or a routine' : 'Find a task or an agent'
  let index = -1

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Find on the board"
      data-testid="calendar-find"
      className="surface-floating-tier board-pop-in board-ink-focus fixed z-[75] flex flex-col overflow-hidden rounded-2xl"
      style={
        {
          left: pos.left,
          top: pos.top,
          bottom: pos.bottom,
          width: WIDTH,
          maxHeight: pos.maxHeight,
          // It grows from the corner nearest the Find button.
          '--pop-origin': pos.top != null ? 'top left' : 'bottom left',
          '--pop-dy': pos.top != null ? '4px' : '-4px',
        } as CSSProperties
      }
    >
      <div className="relative shrink-0 p-2.5 pb-2">
        <Search
          size={14}
          strokeWidth={2}
          aria-hidden
          className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={label}
          aria-describedby={hintId}
          aria-expanded={ordered.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder={label}
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={onKeyDown}
          // The board's ink focus ring is the field's ring too.
          className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-8 text-compact text-foreground transition-colors placeholder:text-muted-foreground focus:border-foreground/40"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            // Keep focus in the field, so typing carries on after the clear.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              changeQuery('')
              inputRef.current?.focus()
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {!trimmed ? (
          <p className="px-2 py-3 text-compact text-muted-foreground">
            {`Type to ${label.toLowerCase()}.`}
          </p>
        ) : ordered.length === 0 ? (
          <p className="px-2 py-3 text-compact text-muted-foreground">
            {`No matches for “${trimmed}”.`}
          </p>
        ) : (
          <div id={listId} role="listbox" aria-label="Results" className="pb-1">
            {groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.label} className="mt-1 first:mt-0">
                <div
                  role="presentation"
                  className="px-2 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground"
                >
                  {group.label}
                </div>
                {group.items.map((r) => {
                  index += 1
                  const i = index
                  const isActive = i === activeIndex
                  return (
                    <div
                      key={keyOf(r)}
                      id={optionId(i)}
                      role="option"
                      aria-selected={isActive}
                      data-kind={r.kind}
                      // The field keeps focus; a press only picks.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => {
                        if (i !== activeIndex) setActive(i)
                      }}
                      onClick={(e) => pick(r, e.shiftKey)}
                      className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5"
                      style={{
                        background: isActive ? 'rgb(var(--foreground-rgb) / 0.07)' : undefined,
                      }}
                    >
                      {r.kind === 'task' ? (
                        <TaskRow
                          result={r}
                          columnName={columnName(r.column)}
                          day={dayLabel(r.at)}
                          owner={ownerOf(r.task)}
                          agentName={agentName}
                        />
                      ) : (
                        <>
                          <Repeat
                            size={12}
                            strokeWidth={2}
                            aria-hidden
                            className="mt-[3px] shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate text-compact text-foreground">
                            {r.name}
                          </span>
                          <span className="shrink-0 text-xs leading-4.5 text-muted-foreground">
                            Routine
                          </span>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3.5 py-2 text-xs text-muted-foreground">
        {more > 0 ? <p className="mb-0.5">{`+${more} more. Keep typing to narrow it.`}</p> : null}
        <p id={hintId}>Enter shows it · Shift+Enter opens it</p>
      </div>
      <div role="status" className="sr-only">
        {trimmed
          ? results.length === 0
            ? 'No results'
            : `${results.length} ${results.length === 1 ? 'result' : 'results'}`
          : ''}
      </div>
    </div>,
    document.body,
  )
}

/** A task result: its column's glyph, the title, why it matched, its day and its Boo. */
function TaskRow({
  result,
  columnName,
  day,
  owner,
  agentName,
}: {
  result: FindTaskResult
  /** Said with the title, since the glyph alone is a picture. */
  columnName: string
  day: string
  owner: string | null
  agentName: (agentId: string) => string | null
}) {
  const note = matchNote(result, owner, agentName)
  return (
    <>
      <span aria-hidden className="flex h-[18px] shrink-0 items-center">
        <StatusGlyph kind={glyphKindOf(result.column)} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={[
            'block truncate text-compact',
            // Cancelled is struck through, as on its card.
            result.column === 'cancelled'
              ? 'text-muted-foreground line-through'
              : 'text-foreground',
          ].join(' ')}
        >
          {result.task.title || 'Untitled task'}
          <span className="sr-only">{`, ${columnName}`}</span>
        </span>
        {note ? <span className="block truncate text-xs text-muted-foreground">{note}</span> : null}
      </span>
      <span className="shrink-0 text-xs leading-4.5 tabular-nums text-muted-foreground">{day}</span>
      {owner ? (
        <span aria-hidden className="flex h-[18px] shrink-0 items-center">
          <AgentBooAvatar agentId={owner} size={16} />
        </span>
      ) : null}
    </>
  )
}
