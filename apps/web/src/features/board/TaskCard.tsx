// A task's card on the board, and its drag-and-drop wrapper. The board draws
// every card as a calendar chip, stamped with when it was added, started or
// finished; without a stamp and an accent the card takes a plain form.

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { delegationTargetOf, type TaskRunCost } from '@clawboo/board-core'
import {
  Check,
  CheckCircle2,
  CircleDashed,
  CornerDownRight,
  GripVertical,
  Timer,
  X,
} from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { MarkGlyph, resolveRuntimeMark, runtimeLabel } from '@/features/runtimes/RuntimeBrand'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import type { BoardTask } from '@/lib/boardClient'
import { useFleetStore } from '@/stores/fleet'

import { boardColumnOf } from './boardStatus'
import { isFinishedStatus } from './calendar/calendarModel'
import { sitsOnOtherDay } from './finishMove'
import { formatCostUsd, formatRunCost, runCostOf } from './taskCost'

/** The runtimes the board has a name and a mark for. */
const KNOWN_RUNTIMES = new Set(['openclaw', 'clawboo-native', 'claude-code', 'codex', 'hermes'])

/** A runtime's display name: the brand name for a runtime the app knows, its raw id otherwise. */
export function runtimeNameOf(runtime: string): string {
  return KNOWN_RUNTIMES.has(runtime) ? runtimeLabel(runtime) : runtime
}

/**
 * The agent a task belongs to: its assignee, or the agent it is bound to while it
 * waits in To do (a person's assignment, or a delegation queued behind that
 * agent's current turn). Null when nobody has it.
 */
export function taskOwnerOf(task: BoardTask): string | null {
  if (typeof task.assigneeAgentId === 'string' && task.assigneeAgentId) return task.assigneeAgentId
  const sdid = typeof task['sourceDelegationId'] === 'string' ? task['sourceDelegationId'] : null
  return delegationTargetOf(sdid)
}

/**
 * The runtime a task runs on, or null when it has none.
 *
 * Open work reads its agent's runtime: the team engine stores
 * `assigneeRuntime: 'openclaw'` on a task until its run ends, whatever the agent
 * runs on. Finished work reads the runtime its run recorded, else its agent's.
 */
export function taskRuntimeOf(
  task: BoardTask,
  agentRuntime: string | null | undefined,
): string | null {
  const recorded =
    typeof task['assigneeRuntime'] === 'string' && task['assigneeRuntime']
      ? task['assigneeRuntime']
      : null
  if (isFinishedStatus(task.status)) return recorded ?? agentRuntime ?? null
  return agentRuntime || null
}

/** An agent's runtime from the fleet, or null when the agent is unknown. */
export function useAgentRuntime(agentId: string | null): string | null {
  return useFleetStore((s) =>
    agentId ? (s.agents.find((a) => a.id === agentId)?.runtime ?? null) : null,
  )
}

function verdictStatus(task: BoardTask): 'pass' | 'fail' | 'completed_with_debt' | null {
  const v = task['verification']
  if (!v) return null
  try {
    const parsed = (typeof v === 'string' ? JSON.parse(v) : v) as {
      status?: 'pass' | 'fail' | 'completed_with_debt'
    }
    return parsed.status ?? null
  } catch {
    return null
  }
}

const VERDICT_META: Record<
  'pass' | 'fail' | 'completed_with_debt',
  { tone: StatusTone; label: string }
> = {
  pass: { tone: 'success', label: 'pass' },
  fail: { tone: 'error', label: 'fail' },
  completed_with_debt: { tone: 'warning', label: 'debt' },
}

/** When a calendar card's task was added or finished, as the card shows it. */
export interface CardStamp {
  /** The visible text: a time, or a date for a card from before the range. */
  label: string
  /** The full sentence a tooltip and a screen reader get. */
  title: string
  /** The task finished, so the stamp carries a check. */
  finished: boolean
  /** The label is a date, not a time: it is set in Inter, since mono is for times. */
  dated?: boolean
  /** The label is how long the task's run has been going, not when it was added. */
  running?: boolean
}

/** A chip mark's label, naming the subtask when the chip has no room for its own mark. */
function withSubtask(label: string, subtask: boolean): string {
  return subtask ? `${label}. Subtask` : label
}

/** A small icon mark for a chip's meta row, with its meaning as a tooltip and for screen readers. */
function IconMark({
  label,
  className,
  children,
}: {
  label: string
  className: string
  children: ReactNode
}) {
  return (
    <span title={label} className={`inline-flex shrink-0 items-center ${className}`}>
      {children}
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * The one status mark a calendar chip shows, or null. Verifying comes first, then
 * a verdict that did not pass, then a pass (only before Done, whose stamp already
 * carries the check). A subtask's mark names the subtask in its tooltip and for
 * screen readers, so the row has no separate subtask mark to fit.
 */
function chipStatusMark(
  status: string,
  verdict: 'pass' | 'fail' | 'completed_with_debt' | null,
  subtask: boolean,
): ReactNode {
  if (status === 'in_review') {
    return (
      <span
        title={subtask ? withSubtask('Verifying', true) : undefined}
        className="inline-flex shrink-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground"
      >
        <span aria-hidden className="board-pulse-dot size-[5px] shrink-0 rounded-full bg-mint" />
        <span>Verifying</span>
        {subtask ? <span className="sr-only">. Subtask</span> : null}
      </span>
    )
  }
  if (verdict === 'completed_with_debt') {
    return (
      <IconMark label={withSubtask('Passed with debt', subtask)} className="text-amber">
        <CircleDashed size={12} strokeWidth={2.2} aria-hidden />
      </IconMark>
    )
  }
  if (verdict === 'fail') {
    return (
      <IconMark label={withSubtask('Verification failed', subtask)} className="text-amber">
        <X size={12} strokeWidth={2.4} aria-hidden />
      </IconMark>
    )
  }
  if (verdict === 'pass' && status !== 'done') {
    return (
      <IconMark label={withSubtask('Verified', subtask)} className="text-mint">
        <Check size={12} strokeWidth={2.4} aria-hidden />
      </IconMark>
    )
  }
  return null
}

/** A recorded cost in the card's data face. */
function CostLabel({
  usd,
  estimated,
  compact = false,
  subtask = false,
}: {
  usd: number
  estimated: boolean
  /**
   * A chip has room for cents at most. A sub-cent cost reads "<$0.01", which
   * already says it is not exact; a larger estimate carries a tilde. The exact
   * figure and whether it is an estimate are in the title and for screen readers.
   */
  compact?: boolean
  /** The chip is a subtask: its cost names that too, so the row needs no arrow. */
  subtask?: boolean
}) {
  if (compact) {
    const exact = formatCostUsd(usd)
    const shown = usd > 0 && usd < 0.01 ? '<$0.01' : `${estimated ? '~' : ''}${exact}`
    const detail = estimated
      ? 'estimated, not a charge the runtime reported'
      : 'the cost the runtime reported'
    return (
      <span
        data-testid="board-card-cost"
        className="font-data shrink-0 text-[11px] tabular-nums text-muted-foreground"
        title={withSubtask(`${exact}, ${detail}`, subtask)}
      >
        <span aria-hidden>{shown}</span>
        <span className="sr-only">
          {withSubtask(`Cost ${exact}${estimated ? ', estimated' : ''}`, subtask)}
        </span>
      </span>
    )
  }
  const title = estimated
    ? 'Estimated, not a charge the runtime reported'
    : 'Cost the runtime reported'
  return (
    <span
      data-testid="board-card-cost"
      className="font-data text-[11px] tabular-nums text-muted-foreground"
      title={title}
    >
      {formatRunCost(usd, estimated)}
    </span>
  )
}

/**
 * A calendar chip's meta row, one line: who has it, the runtime it runs on, at
 * most one status mark (else its cost), a subtask arrow when neither of those has
 * taken the subtask into its own label, and the stamp at the end. Every mark paints in the chip's ink or a
 * status colour, never a brand colour.
 */
function ChipMeta({
  task,
  stamp,
  ownerId,
  ownerName,
  runtime,
  mark,
  cost,
}: {
  task: BoardTask
  stamp: CardStamp
  ownerId: string | null
  ownerName: string | null
  runtime: string | null
  mark: ReactNode
  cost: TaskRunCost
}) {
  const subtask = !!task['parentTaskId']
  return (
    <div className="flex min-h-4 flex-wrap items-center gap-x-1 gap-y-1">
      {ownerId ? (
        <span title={ownerName ?? undefined} className="inline-flex shrink-0 items-center">
          <AgentBooAvatar agentId={ownerId} size={16} />
          <span className="sr-only">{`Assigned to ${ownerName ?? 'an agent'}`}</span>
        </span>
      ) : (
        <span
          title="Unassigned"
          className="size-4 shrink-0 rounded-full"
          style={{ border: '1px dashed var(--border-strong)' }}
        >
          <span className="sr-only">Unassigned</span>
        </span>
      )}
      {runtime ? (
        KNOWN_RUNTIMES.has(runtime) ? (
          <span
            title={runtimeLabel(runtime)}
            className="inline-flex shrink-0 text-muted-foreground"
          >
            <MarkGlyph glyph={resolveRuntimeMark(runtime).glyph} size={11} />
            <span className="sr-only">{`Runtime: ${runtimeLabel(runtime)}`}</span>
          </span>
        ) : (
          <span className="shrink-0 text-[11px] leading-4 text-muted-foreground">
            <span className="sr-only">Runtime: </span>
            {runtime}
          </span>
        )
      ) : null}
      {mark ??
        (cost.usd !== null ? (
          <CostLabel usd={cost.usd} estimated={cost.estimated} subtask={subtask} compact />
        ) : null)}
      {subtask && mark == null && cost.usd === null ? (
        <IconMark label="Subtask" className="text-muted-foreground">
          <CornerDownRight size={11} strokeWidth={2} aria-hidden />
        </IconMark>
      ) : null}
      <StampLabel stamp={stamp} />
    </div>
  )
}

/** When the task was added or finished, at the end of a calendar card's meta row.
 *  A time is set in mono; a date is words, so it is set in Inter. */
function StampLabel({ stamp }: { stamp: CardStamp }) {
  return (
    <span
      data-testid="board-card-stamp"
      title={stamp.title}
      className={`${stamp.dated ? '' : 'font-data '}ml-auto inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground`}
    >
      {stamp.finished ? (
        <CheckCircle2 size={12} strokeWidth={2.2} className="text-mint" aria-hidden />
      ) : stamp.running ? (
        <Timer size={11} strokeWidth={2.2} aria-hidden />
      ) : null}
      {stamp.label}
      <span className="sr-only">{`, ${stamp.title}`}</span>
    </span>
  )
}

/**
 * A calendar chip's classes for its state. The chip's CSS owns every transition
 * and animation; the class or data attribute only names the state.
 */
function chipStateClasses({
  arrived,
  settle,
  lifted,
  dragging,
}: {
  arrived?: boolean
  settle?: boolean
  lifted?: boolean
  dragging?: boolean
}): string {
  return [
    // A card in the hand, or the copy it left behind, stays put under the pointer.
    lifted || dragging ? '' : 'hover:-translate-y-px',
    arrived ? 'calendar-chip--arrived' : '',
    settle ? 'calendar-chip--settle' : '',
    lifted ? 'calendar-chip--lifted' : '',
    dragging ? 'calendar-chip--source' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** How long the pointer or focus rests on a card before it counts as looked at. */
const LOOK_MS = 600

/**
 * Pointer and focus handlers that call `onSeen` once the person has rested on
 * the card for a moment. A pass on the way to somewhere else does not count.
 */
function useLook(onSeen: (() => void) | undefined) {
  const timer = useRef(0)
  const seen = useRef(onSeen)
  seen.current = onSeen
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (!onSeen) return {}
  const start = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => seen.current?.(), LOOK_MS)
  }
  const stop = () => window.clearTimeout(timer.current)
  return { onPointerEnter: start, onPointerLeave: stop, onFocus: start, onBlur: stop }
}

export function TaskCard({
  task,
  onClick,
  stamp,
  accent,
  open,
  past,
  arrived,
  settle,
  lifted,
  dragging,
  clamp,
  unseen,
  onSeen,
  onDragPointerDown,
}: {
  task: BoardTask
  onClick: () => void
  /** Calendar cards carry a stamp: when it was added, started or finished. */
  stamp?: CardStamp
  /** A calendar card is an event chip in its column's colour (a CSS colour). */
  accent?: string
  // The rest apply to calendar chips only (stamp and accent both set).
  /** Its drawer is open. */
  open?: boolean
  /** It finished on a day before today. */
  past?: boolean
  /** An agent just put it here. */
  arrived?: boolean
  /** The person just set it down. */
  settle?: boolean
  /** It is drawn in the drag overlay, in the person's hand. */
  lifted?: boolean
  /** It is the copy left in its cell while it is being dragged. */
  dragging?: boolean
  /** Its title keeps to one line, with the rest in the tooltip: finished work
   *  from a day before today. */
  clamp?: boolean
  /** It changed while the person was away, so it carries a dot until they look. */
  unseen?: boolean
  /** The person has looked at it: rested the pointer or focus on it for a moment. */
  onSeen?: () => void
  /** Starts a pointer drag from anywhere on the card (DraggableCard supplies it). */
  onDragPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  const ownerId = taskOwnerOf(task)
  const ownerName = useFleetStore((s) =>
    ownerId ? (s.agents.find((a) => a.id === ownerId)?.name ?? null) : null,
  )
  const runtime = taskRuntimeOf(task, useAgentRuntime(ownerId))
  const cost = runCostOf(task)
  const verdict = verdictStatus(task)
  const chip = stamp != null && accent != null
  const mark = chip ? chipStatusMark(task.status, verdict, Boolean(task['parentTaskId'])) : null
  // A chip shows one mark; when that mark takes the cost's place, the cost moves
  // into the card's tooltip.
  const costTip =
    mark != null && cost.usd !== null ? `Cost: ${formatRunCost(cost.usd, cost.estimated)}` : null
  const title = task.title ?? '(untitled)'
  const clamped = chip && !!clamp
  // A title cut to one line is whole in the tooltip.
  const tip = [clamped ? title : null, costTip].filter(Boolean).join('\n') || undefined
  const look = useLook(unseen ? onSeen : undefined)
  return (
    <button
      type="button"
      data-testid="board-card"
      // A card is destroyed and re-created whenever its task changes column, so the
      // drawer it opened cannot return focus to the captured node. This tags the card
      // with its task id so `useFocusTrap` can re-find it on close (#98).
      data-focus-restore-id={task.id}
      data-open={(chip && open) || undefined}
      data-past={(chip && past) || undefined}
      onClick={onClick}
      onPointerDown={onDragPointerDown}
      {...look}
      title={tip}
      className={[
        'group block w-full cursor-pointer text-left',
        chip
          ? `calendar-chip rounded-lg px-2.5 py-2 ${chipStateClasses({ arrived, settle, lifted, dragging })}`
          : 'border border-border bg-surface transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong',
        chip ? '' : stamp ? 'rounded-xl px-3 py-2.5' : 'rounded-2xl p-4',
      ].join(' ')}
      style={chip ? ({ '--chip': accent } as CSSProperties) : { boxShadow: 'var(--shadow-raised)' }}
    >
      <div
        className={[
          stamp
            ? `${clamped ? 'line-clamp-1' : 'line-clamp-2'} text-[12.5px] font-semibold`
            : 'text-[13px] font-semibold',
          task.status === 'cancelled' && stamp
            ? 'text-muted-foreground line-through decoration-foreground/30'
            : 'text-foreground',
        ].join(' ')}
        style={{
          lineHeight: stamp ? '17px' : 1.35,
          letterSpacing: '-0.01em',
          marginBottom: stamp ? 6 : 9,
          // The drag grip appears at the chip's top right on keyboard focus; the
          // words stop short of it.
          paddingRight: chip ? 18 : undefined,
        }}
      >
        {chip && unseen ? (
          <span
            data-testid="board-card-unseen"
            className="mr-1.5 inline-block size-1.5 rounded-full bg-foreground align-[2px]"
          >
            <span className="sr-only">Changed since you last looked. </span>
          </span>
        ) : null}
        {title}
      </div>
      {chip ? (
        <ChipMeta
          task={task}
          stamp={stamp}
          ownerId={ownerId}
          ownerName={ownerName}
          runtime={runtime}
          mark={mark}
          cost={cost}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {stamp && ownerId ? <AgentBooAvatar agentId={ownerId} size={16} /> : null}
          {task.status === 'in_review' && <StatusPill tone="working" label="Verifying" />}
          {runtime ? <StatusPill tone="idle" label={runtime} /> : null}
          {verdict && (
            <StatusPill tone={VERDICT_META[verdict].tone} label={VERDICT_META[verdict].label} />
          )}
          {cost.usd !== null && <CostLabel usd={cost.usd} estimated={cost.estimated} />}
          {task['parentTaskId'] ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <CornerDownRight size={11} strokeWidth={2} /> sub
            </span>
          ) : null}
          {stamp ? <StampLabel stamp={stamp} /> : null}
        </div>
      )}
    </button>
  )
}

/** How long after a drag ends a click on the card is still the drop, not a person opening it. */
const DROP_CLICK_GUARD_MS = 250

// A card wrapped for drag-and-drop. A mouse or pen drags the card from anywhere on
// it: the pointer sensor waits for 5px of movement, so a plain click still opens
// the drawer. The grip is the labelled target for keyboard pickup (Space, the
// arrows, Space) and for touch, where the card body has to keep scrolling the
// board; it shows on keyboard focus and on screens without hover. A pointer click
// on it opens the card like a click anywhere else on the card, so the corner it
// covers is never dead while it is hidden. Terminal and off-list cards pass
// `disabled` and render no grip.
export function DraggableCard({
  task,
  disabled,
  onOpen,
  stamp,
  accent,
  open,
  past,
  arrived,
  settle,
  clamp,
  unseen,
  onSeen,
}: {
  task: BoardTask
  disabled: boolean
  onOpen: () => void
  stamp?: CardStamp
  accent?: string
  open?: boolean
  past?: boolean
  arrived?: boolean
  settle?: boolean
  clamp?: boolean
  unseen?: boolean
  onSeen?: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    // `title` rides along so the screen-reader announcements can name the card
    // without reaching back into `effectiveTasks`. See boardAnnouncements.ts
    // for why a closure over board state is unsafe at announcement time.
    data: {
      fromStatus: task.status,
      fromColumn: boardColumnOf(task),
      title: task.title ?? '(untitled)',
      sitsToday: sitsOnOtherDay(task, Date.now()) == null,
    },
    disabled,
  })
  const chip = stamp != null && accent != null

  // When this card's last drag ended. A layout effect, so the time is set before
  // the click that can follow a drop reaches the card.
  const dragEndedAt = useRef(0)
  useLayoutEffect(() => {
    if (!isDragging) return
    return () => {
      dragEndedAt.current = Date.now()
    }
  }, [isDragging])
  const handleOpen = () => {
    if (Date.now() - dragEndedAt.current < DROP_CLICK_GUARD_MS) return
    onOpen()
  }

  // Only the pointer sensor's activator reaches the card body, and only for a
  // mouse or pen primary button. The keyboard activator stays on the grip.
  const sensorPointerDown = listeners?.['onPointerDown'] as
    ((e: ReactPointerEvent<HTMLButtonElement>) => void) | undefined
  const onDragPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || e.button !== 0) return
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return
    sensorPointerDown?.(e)
  }

  return (
    <div ref={setNodeRef} className="relative" style={{ opacity: isDragging && !chip ? 0.4 : 1 }}>
      <TaskCard
        task={task}
        onClick={handleOpen}
        stamp={stamp}
        accent={accent}
        open={open}
        past={past}
        arrived={arrived}
        settle={settle}
        clamp={clamp}
        unseen={unseen}
        onSeen={onSeen}
        dragging={chip && isDragging}
        onDragPointerDown={disabled ? undefined : onDragPointerDown}
      />
      {!disabled && (
        <button
          type="button"
          aria-label={`Drag to move “${task.title ?? 'task'}” to another column`}
          // `detail` counts the clicks of a real pointer. Space and Enter pick the
          // card up instead (the keyboard sensor), and a click they cause has a
          // detail of 0, so a keyboard pickup never opens the drawer.
          onClick={(e) => {
            if (e.detail > 0) handleOpen()
          }}
          className="absolute right-1.5 top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-foreground/[0.08] hover:text-foreground focus-visible:cursor-grab focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 [@media(hover:none)]:opacity-100"
          style={{ touchAction: 'none' }}
          {...listeners}
          {...attributes}
        >
          <GripVertical size={14} strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  )
}
