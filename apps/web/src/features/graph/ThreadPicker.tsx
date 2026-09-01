// What a thread can end in, offered where it was dropped.
//
// THE GESTURE THIS COMPLETES already half-existed: React Flow reports a drop on
// empty canvas through `onConnectEnd`, and the handler hard-returned with the
// comment "the gesture just ends". That early return is the one interaction
// every node editor has taught people, drag out and let go and pick what
// appears, and the canvas was throwing it away.
//
// ASK THE KIND FIRST. One flat list put thirty-two skills above nineteen
// connectors, so reaching the first connector meant scrolling past a full
// screen of something else. A kind chooser stays three rows whether the
// connector catalogue holds nineteen entries or four hundred, which a single
// list never does.
//
// TYPING SKIPS THE CHOOSER. Someone who knows the name should not pay for the
// menu, so a non-empty query searches every kind at once and the chooser is on
// screen only while the query is empty. Two things fall out of that for free:
// choosing a kind never has to clear the query, and backspacing to empty is
// already the way back.
//
// ONLY LEGAL ENDINGS ARE LISTED. The rows are filtered by what the source node
// can actually connect to, so an impossible connection is never on screen to be
// attempted. Anything needing more than a name or a pick (a credential, a
// folder, a custom server, a team) is inert or absent rather than linked away,
// because a row that opens another window is the pattern this surface exists to
// remove.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ChevronLeft, Plus, Search } from 'lucide-react'

import {
  ConnectorMark,
  ConnectorMarkStyles,
  hasBrandMark,
} from '@/features/connectors/ConnectorMark'
import { ConnectorsMark, NewAgentMark, SkillsMark } from './ThreadPickerMarks'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import {
  nextEnabled,
  rowEnabled,
  threadCounts,
  threadPickerRows,
  type Row,
  type ThreadKind,
  type ThreadOption,
} from './threadPickerRows'

export type { ThreadKind, ThreadOption } from './threadPickerRows'

export interface ThreadPickerProps {
  /** Screen position of the drop, in client pixels. */
  at: { x: number; y: number }
  options: readonly ThreadOption[]
  /** Whether a new agent can be created from here. */
  allowNewAgent: boolean
  onPick: (option: ThreadOption) => void
  onCreateAgent: (name: string) => void
  onClose: () => void
}

const PANEL_W = 300
const PANEL_MAX_H = 380
const LIST_MAX_H = 320

const KIND_META: Readonly<Record<ThreadKind, { label: string; tint: string }>> = {
  // Tints are the minimap's own node accents, so the chooser reads as a map of
  // the canvas rather than a second taxonomy invented for this menu.
  connector: { label: 'Connectors', tint: 'var(--violet)' },
  skill: { label: 'Skills', tint: 'var(--mint)' },
  agent: { label: 'New agent', tint: 'var(--primary)' },
}

export function ThreadPicker({
  at,
  options,
  allowNewAgent,
  onPick,
  onCreateAgent,
  onClose,
}: ThreadPickerProps) {
  const [kind, setKind] = useState<ThreadKind | null>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [creating, setCreating] = useState(false)
  const [dir, setDir] = useState<1 | -1>(1)
  const [height, setHeight] = useState<number>(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const listId = 'thread-picker-list'

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const counts = useMemo(() => threadCounts(options), [options])
  const q = query.trim().toLowerCase()

  // THE TILE PREVIEWS THIS LIST, so the marks come from the rows actually on
  // offer rather than a hard-coded trio. Only connectors that resolve to a real
  // brand mark qualify: a monogram fanned behind two logos looks like a bug.
  const markSlugs = useMemo(
    () =>
      options
        .filter((o) => o.kind === 'connector' && o.slug !== undefined && hasBrandMark(o.slug))
        .slice(0, 3)
        .map((o) => o.slug as string),
    [options],
  )

  const { rows, sections } = useMemo(
    () => threadPickerRows({ kind, query, options, allowNewAgent }),
    [kind, query, options, allowNewAgent],
  )

  useEffect(() => {
    setActiveIndex(rows.findIndex((r) => rowEnabled(r)))
  }, [rows])

  const paneKey = kind ?? (q === '' ? 'root' : 'results')

  // The panel grows and shrinks with its contents, which is most of what makes
  // this feel like a node editor rather than a menu that jumps.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = (): void => setHeight(Math.min(LIST_MAX_H, el.scrollHeight))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [paneKey, rows.length])

  const back = useCallback(() => {
    setDir(-1)
    setKind(null)
    setQuery('')
  }, [])

  // Escape is a ladder, and it lives here rather than on the input. The house
  // rule is that the layer stack owns dismissal; handling Escape on the input
  // and calling preventDefault would veto the stack, because its own handler
  // bails on an already-defaulted event.
  useDismissableLayer({
    active: true,
    level: 'popover',
    contains: (target) => Boolean(panelRef.current?.contains(target)),
    onPressOutside: onClose,
    onEscape: () => {
      if (query !== '') {
        setQuery('')
        return
      }
      if (kind !== null) {
        back()
        return
      }
      onClose()
    },
  })

  const commit = useCallback(
    (row: Row | undefined) => {
      if (!row) return
      if (row.type === 'kind') {
        setDir(1)
        setKind(row.kind)
        return
      }
      if (row.type === 'option') {
        if (row.option.disabledReason) return
        onPick(row.option)
        return
      }
      if (row.name === '' || creating) return
      setCreating(true)
      onCreateAgent(row.name)
    },
    [creating, onCreateAgent, onPick],
  )

  const move = useCallback(
    (delta: number) => {
      const i = nextEnabled(rows, activeIndex, delta)
      if (i >= 0) setActiveIndex(i)
    },
    [activeIndex, rows],
  )

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(rows[activeIndex])
    } else if (e.key === 'ArrowRight' && kind === null && q === '') {
      e.preventDefault()
      commit(rows[activeIndex])
    } else if (e.key === 'ArrowLeft' && kind !== null) {
      // CARET GUARD. Without it the left arrow stops being a text-editing key
      // the moment you are one level deep.
      const el = e.currentTarget
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault()
        back()
      }
    } else if (e.key === 'Backspace' && query === '' && kind !== null) {
      e.preventDefault()
      back()
    } else if (e.key === 'Tab') {
      onClose()
    }
  }

  // Kept inside the viewport: a picker opened near the right or bottom edge
  // would otherwise render half off-screen, which is where drops often land.
  const left = Math.min(at.x, window.innerWidth - PANEL_W - 16)
  const top = Math.min(at.y, window.innerHeight - PANEL_MAX_H - 16)

  const placeholder =
    kind === 'agent'
      ? 'Name the new agent'
      : kind
        ? `Search ${KIND_META[kind].label.toLowerCase()}`
        : 'Search, or pick below'

  const pane = { duration: reduced ? 0 : 0.18, ease: [0.32, 0.72, 0, 1] as const }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Connect to"
      className="fixed z-50 overflow-hidden rounded-xl border border-border bg-surface"
      style={{
        left: Math.max(8, left),
        top: Math.max(8, top),
        width: PANEL_W,
        boxShadow: 'var(--shadow-raised)',
      }}
    >
      {/* The marks need their colour variables, and the connectors panel that
        normally mounts them is a lazy route that is not open on the canvas. */}
      <ConnectorMarkStyles />

      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        {kind ? (
          <button
            type="button"
            onClick={back}
            aria-label="Back to what to add"
            className="-ml-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
        ) : (
          <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `tp-row-${activeIndex}` : undefined}
          className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <motion.div
        className="relative overflow-hidden"
        initial={false}
        animate={{ height }}
        transition={{ duration: reduced ? 0 : 0.22, ease: [0.32, 0.72, 0, 1] }}
      >
        <AnimatePresence initial={false} custom={dir}>
          <motion.div
            key={paneKey}
            custom={dir}
            initial={{ opacity: 0, x: reduced ? 0 : dir * 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduced ? 0 : dir * -12 }}
            transition={pane}
            className="absolute inset-x-0 top-0"
          >
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Connect to"
              className="max-h-[320px] overflow-y-auto py-1"
            >
              {sections.map((s) => (
                <div key={s.label} role="group" aria-label={s.label} className="px-1">
                  <div
                    aria-hidden
                    className="sticky top-0 z-10 bg-surface px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
                  >
                    {s.label}
                  </div>
                  {rows.slice(s.start, s.end).map((row, n) => {
                    const i = s.start + n
                    return (
                      <RowView
                        key={rowKey(row, i)}
                        row={row}
                        index={i}
                        active={i === activeIndex}
                        counts={counts}
                        markSlugs={markSlugs}
                        onHover={() => rowEnabled(row) && setActiveIndex(i)}
                        onCommit={() => commit(row)}
                      />
                    )
                  })}
                </div>
              ))}
              {rows.length === 0 && (
                <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                  Nothing here matches <span className="text-foreground">{query.trim()}</span>.
                </p>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

function rowKey(row: Row, i: number): string {
  if (row.type === 'kind') return `kind:${row.kind}`
  if (row.type === 'option') return row.option.id
  return `create:${i}`
}

function RowView({
  row,
  index,
  active,
  counts,
  markSlugs,
  onHover,
  onCommit,
}: {
  row: Row
  index: number
  active: boolean
  counts: { connector: number; connectorReady: number; skill: number }
  /** Connectors to preview on the chooser's connector tile. */
  markSlugs: readonly string[]
  onHover: () => void
  onCommit: () => void
}) {
  const base =
    'flex w-full items-center gap-2 rounded-lg px-2 text-left transition-colors duration-150'
  const highlight = active ? 'bg-foreground/[0.055]' : ''

  if (row.type === 'kind') {
    const meta = KIND_META[row.kind]
    const sub =
      row.kind === 'connector'
        ? counts.connectorReady > 0
          ? `${counts.connector} to add, ${counts.connectorReady} in one click`
          : `${counts.connector} to add`
        : row.kind === 'skill'
          ? `${counts.skill} to add`
          : 'Name one and route this thread to it'
    return (
      <button
        type="button"
        id={`tp-row-${index}`}
        role="option"
        aria-selected={active}
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={onHover}
        onClick={onCommit}
        className={`${base} cursor-pointer py-2.5 ${highlight}`}
      >
        {row.kind === 'connector' ? (
          <ConnectorsMark slugs={markSlugs} tint={meta.tint} />
        ) : row.kind === 'skill' ? (
          <SkillsMark tint={meta.tint} />
        ) : (
          <NewAgentMark tint={meta.tint} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight text-foreground">
            {meta.label}
          </span>
          <span className="block truncate text-[11px] leading-snug text-muted-foreground">
            {sub}
          </span>
        </span>
      </button>
    )
  }

  if (row.type === 'createAgent') {
    const ready = row.name !== ''
    return (
      <button
        type="button"
        id={`tp-row-${index}`}
        role="option"
        aria-selected={active}
        aria-disabled={!ready}
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={onHover}
        onClick={onCommit}
        className={`${base} py-1.5 ${ready ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'} ${highlight}`}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/55">
          <Plus size={13} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] leading-tight text-foreground">
          {ready ? `Create "${row.name}"` : 'Type a name'}
        </span>
      </button>
    )
  }

  const o = row.option
  return (
    <button
      type="button"
      id={`tp-row-${index}`}
      role="option"
      aria-selected={active}
      aria-disabled={Boolean(o.disabledReason)}
      title={o.disabledReason ?? o.hint}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onCommit}
      className={`${base} py-1.5 ${o.disabledReason ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'} ${highlight}`}
    >
      {o.slug ? (
        <ConnectorMark slug={o.slug} displayName={o.label} size={24} />
      ) : (
        <span className="size-6 shrink-0 rounded-md bg-foreground/[0.06]" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-tight text-foreground">{o.label}</span>
        {o.hint && (
          <span className="block truncate text-[11px] leading-snug text-muted-foreground">
            {o.hint}
          </span>
        )}
      </span>
      {o.action && !o.disabledReason && (
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
          {o.action}
        </span>
      )}
    </button>
  )
}
