// The board's toolbar controls: quiet 28px outline buttons that sit in one row
// and line up without per-site tuning. Find, Filter, Display and the view
// switch, the "agents working" chip, and the background-refresh spinner. A
// control turns a step darker only while it is "on" (a filter set, a menu
// open); everything else is the same muted ink.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ListFilter, SlidersHorizontal } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

import { BoardMenu, type BoardMenuItem } from './BoardMenu'

/** A toolbar button: 28px, an outline, muted words that firm up on hover. */
export const TOOLBAR_BUTTON =
  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2'
const OFF = 'border-border text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
const ON = 'border-border-strong bg-foreground/[0.06] text-foreground'

/** A toolbar button's classes, "on" while its filter is set or its menu is open. */
export function toolbarButton(on: boolean): string {
  return `${TOOLBAR_BUTTON} ${on ? ON : OFF}`
}

/** True once `flag` has held for `ms`: a refresh that comes back quickly never
 *  flashes a spinner. */
export function useDelayedFlag(flag: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!flag) {
      setLate(false)
      return
    }
    const timer = window.setTimeout(() => setLate(true), ms)
    return () => window.clearTimeout(timer)
  }, [flag, ms])
  return flag && late
}

const GAP = 4
const EDGE = 8

/**
 * A small popover under a toolbar button, right-aligned to it. Portalled with
 * fixed positioning, on the dismissable-layer stack (Escape and a press outside
 * close it), and it takes focus on open and gives it back on close.
 */
export function ToolbarPopover({
  anchor,
  label,
  width,
  onClose,
  testId,
  children,
}: {
  anchor: HTMLElement
  label: string
  width: number
  onClose: () => void
  testId?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismissableLayer({
    active: true,
    level: 'popover',
    onEscape: onClose,
    contains: (t) => !!ref.current?.contains(t) || anchor.contains(t),
    onPressOutside: onClose,
  })
  const [top, setTop] = useState(() => anchor.getBoundingClientRect().bottom + GAP)
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const h = ref.current?.offsetHeight ?? 0
    setTop(
      r.bottom + GAP + h > window.innerHeight - EDGE
        ? Math.max(EDGE, r.top - GAP - h)
        : r.bottom + GAP,
    )
    ref.current
      ?.querySelector<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ?.focus()
    return () => {
      // Back to the button, unless something else has taken focus on purpose.
      const a = document.activeElement
      if ((!a || a === document.body || !a.isConnected) && anchor.isConnected) anchor.focus()
    }
  }, [anchor])
  const r = anchor.getBoundingClientRect()
  const left = Math.min(Math.max(EDGE, r.right - width), window.innerWidth - width - EDGE)
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-testid={testId}
      className="board-pop-in board-ink-focus fixed z-[100] rounded-xl border border-border bg-popover p-3"
      style={{ top, left, width, boxShadow: 'var(--shadow-floating)' }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** An on/off switch in the board's ink: red is today's, so the board's switches
 *  never use it. */
export function InkToggle({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  testId?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
        checked ? 'bg-foreground' : 'bg-foreground/15',
      ].join(' ')}
    >
      <span
        aria-hidden
        className="absolute left-[3px] size-3 rounded-full bg-background shadow-sm transition-transform"
        style={{ transform: checked ? 'translateX(14px)' : 'none' }}
      />
    </button>
  )
}

/** A view the switch offers: its name, its key and its icon. */
export interface ViewOption<T extends string> {
  id: T
  label: string
  keycap: string
  icon: ReactNode
}

/** The view switch: one button naming the view, opening the list of views. */
export function ViewMenuButton<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: ViewOption<T>[]
  onChange: (id: T) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const current = options.find((o) => o.id === value) ?? options[0]!
  return (
    <>
      <button
        type="button"
        data-testid="board-view"
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        aria-label={`View: ${current.label}`}
        title="Change the view"
        onClick={(e) => {
          const el = e.currentTarget
          setAnchor((a) => (a ? null : el))
        }}
        className={toolbarButton(anchor != null)}
      >
        <span aria-hidden className="flex">
          {current.icon}
        </span>
        {current.label}
        <ChevronDown size={14} strokeWidth={2} aria-hidden />
      </button>
      {anchor ? (
        <BoardMenu
          anchor={anchor}
          label="Board view"
          width={184}
          testId="board-view-menu"
          onClose={() => setAnchor(null)}
          items={options.map((o) => ({
            key: o.id,
            label: o.label,
            icon: o.icon,
            keycap: o.keycap,
            checked: o.id === value,
            testId: `board-view-${o.id}`,
            onSelect: () => onChange(o.id),
          }))}
        />
      ) : null}
    </>
  )
}

/** What the board is narrowed to: some agents, the tasks nobody has, the work
 *  running now. Empty sets and false mean "everything". */
export interface BoardFilter {
  agents: ReadonlySet<string>
  unowned: boolean
  running: boolean
}

export const NO_FILTER: BoardFilter = { agents: new Set(), unowned: false, running: false }

export function filterCount(f: BoardFilter): number {
  return f.agents.size + (f.unowned ? 1 : 0) + (f.running ? 1 : 0)
}

/** Filter: the agents in scope, the tasks with no agent, and the running work. */
export function FilterMenuButton({
  agents,
  filter,
  onChange,
}: {
  agents: { id: string; name: string }[]
  filter: BoardFilter
  onChange: (next: BoardFilter) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const count = filterCount(filter)
  const toggleAgent = (id: string) => {
    const agentsNext = new Set(filter.agents)
    if (agentsNext.has(id)) agentsNext.delete(id)
    else agentsNext.add(id)
    onChange({ ...filter, agents: agentsNext })
  }
  const items: BoardMenuItem[] = [
    ...agents.map((a, i) => ({
      key: a.id,
      label: a.name,
      group: i === 0 ? 'Agents' : undefined,
      icon: <AgentBooAvatar agentId={a.id} size={16} />,
      checked: filter.agents.has(a.id),
      onSelect: () => toggleAgent(a.id),
    })),
    {
      key: 'unowned',
      label: 'No agent',
      group: agents.length === 0 ? 'Agents' : undefined,
      checked: filter.unowned,
      onSelect: () => onChange({ ...filter, unowned: !filter.unowned }),
    },
    {
      key: 'running',
      label: 'Running now',
      separator: true,
      checked: filter.running,
      onSelect: () => onChange({ ...filter, running: !filter.running }),
    },
    ...(count > 0
      ? [
          {
            key: 'clear',
            label: 'Clear filters',
            separator: true,
            onSelect: () => onChange(NO_FILTER),
          },
        ]
      : []),
  ]
  return (
    <>
      <button
        type="button"
        data-testid="board-filter"
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        aria-label={count > 0 ? `Filter, ${count} on` : 'Filter'}
        onClick={(e) => {
          const el = e.currentTarget
          setAnchor((a) => (a ? null : el))
        }}
        className={toolbarButton(count > 0 || anchor != null)}
      >
        <ListFilter size={14} strokeWidth={2} aria-hidden />
        Filter
        {count > 0 ? <span className="tabular-nums">{count}</span> : null}
      </button>
      {anchor ? (
        <BoardMenu
          anchor={anchor}
          label="Filter the board"
          width={220}
          multi
          testId="board-filter-menu"
          onClose={() => setAnchor(null)}
          items={items}
        />
      ) : null}
    </>
  )
}

/** What the cards show besides the title and the agent. */
export interface CardProperties {
  cost: boolean
  time: boolean
}

/** A toggle chip: a property shown or hidden on every card. */
function PropertyChip({
  label,
  on,
  onChange,
}: {
  label: string
  on: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={[
        'inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
        on
          ? 'border-border-strong bg-foreground/[0.06] text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
      ].join(' ')}
    >
      {on ? <Check size={12} strokeWidth={2} aria-hidden /> : null}
      {label}
    </button>
  )
}

/** One line of the Display popover: a name, a note under it, its switch. */
function DisplayRow({
  name,
  note,
  children,
}: {
  name: string
  note?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-compact text-foreground">{name}</span>
        {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
      </span>
      {children}
    </div>
  )
}

/** Display: what the board shows. Routine runs (on the calendar views), the
 *  Cancelled column, and the cost and time on each card. */
export function DisplayButton({
  routines,
  cancelledOpen,
  onCancelledOpenChange,
  card,
  onCardChange,
}: {
  /** The routine runs switch, on the views that draw runs. */
  routines: { show: boolean; onChange: (show: boolean) => void; note: string } | null
  cancelledOpen: boolean
  onCancelledOpenChange: (open: boolean) => void
  card: CardProperties
  onCardChange: (next: CardProperties) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <button
        type="button"
        data-testid="board-display"
        aria-haspopup="dialog"
        aria-expanded={anchor != null}
        onClick={(e) => {
          const el = e.currentTarget
          setAnchor((a) => (a ? null : el))
        }}
        className={toolbarButton(anchor != null)}
      >
        <SlidersHorizontal size={14} strokeWidth={2} aria-hidden />
        Display
      </button>
      {anchor ? (
        <ToolbarPopover
          anchor={anchor}
          label="Display"
          width={264}
          testId="board-display-popover"
          onClose={() => setAnchor(null)}
        >
          {routines ? (
            <DisplayRow name="Routine runs" note={routines.note}>
              <InkToggle
                label="Routine runs"
                testId="board-routines-toggle"
                checked={routines.show}
                onChange={routines.onChange}
              />
            </DisplayRow>
          ) : null}
          <DisplayRow name="Cancelled column">
            <InkToggle
              label="Cancelled column"
              testId="board-cancelled-toggle"
              checked={cancelledOpen}
              onChange={onCancelledOpenChange}
            />
          </DisplayRow>
          <p className="mb-2 mt-3 text-xs font-medium text-muted-foreground">On cards</p>
          <div className="flex flex-wrap gap-1.5">
            <PropertyChip
              label="Cost"
              on={card.cost}
              onChange={(cost) => onCardChange({ ...card, cost })}
            />
            <PropertyChip
              label="Time"
              on={card.time}
              onChange={(time) => onCardChange({ ...card, time })}
            />
          </div>
        </ToolbarPopover>
      ) : null}
    </>
  )
}

/** "2 agents working": the agents with a run going, as a quiet chip that shows
 *  only their running work when pressed. Hidden while nobody is working. */
export function AgentsWorkingChip({
  agentIds,
  on,
  onToggle,
}: {
  agentIds: string[]
  on: boolean
  onToggle: () => void
}) {
  // While its filter is on the chip stays, even once the last run ends, so the
  // control that narrowed the board is still there to widen it.
  if (agentIds.length === 0 && !on) return null
  const n = agentIds.length
  return (
    <button
      type="button"
      data-testid="board-agents-working"
      aria-pressed={on}
      onClick={onToggle}
      title={on ? 'Show all the work again' : 'Show only the work running now'}
      className={toolbarButton(on)}
    >
      {n > 0 ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-mint" /> : null}
      <span aria-hidden className="flex items-center">
        {agentIds.slice(0, 3).map((id, i) => (
          <span
            key={id}
            className="inline-flex size-4 items-center justify-center rounded-full bg-surface"
            style={{ marginLeft: i === 0 ? 0 : -5, boxShadow: '0 0 0 2px var(--surface)' }}
          >
            <AgentBooAvatar agentId={id} size={16} />
          </span>
        ))}
      </span>
      {n === 0 ? 'No agents working' : n === 1 ? '1 agent working' : `${n} agents working`}
    </button>
  )
}
