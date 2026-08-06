import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  Bot,
  CornerDownRight,
  GripVertical,
  KanbanSquare,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react'

import { useTeamStore } from '@/stores/team'
import { fetchBoardResult, type BoardTask } from '@/lib/boardClient'
import { useReadSequencer } from '@/lib/useReadSequencer'
import { useVisiblePolling } from '@/lib/useVisiblePolling'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Skeleton } from '@/features/shared/Skeleton'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'
import { ENTER_SPRING, listDelay } from '@/lib/motion'

import { TaskDetailDrawer } from './TaskDetailDrawer'
import { ApprovalsColumn } from './ApprovalsColumn'
import { NewTaskDialog } from './NewTaskDialog'
import { STATUS_LABEL, TASK_STATUSES, canTransition, statusOptions } from './boardStatus'
import { BOARD_ACCESSIBILITY, OTHER_COLUMN } from './boardAnnouncements'
import { useStatusMutation } from './useStatusMutation'
import { resolveDrop } from './resolveDrop'

const SECTION_LABEL =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'
const COUNT_PILL =
  'font-data rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-foreground/55'

// One column per canonical status, in lifecycle order. Derived from the shared
// status metadata so the columns, the New-task composer, and the drawer's status
// editor never drift on labels or ordering.
const COLUMNS: { id: string; label: string }[] = TASK_STATUSES.map((id) => ({
  id,
  label: STATUS_LABEL[id],
}))
const COLUMN_IDS = new Set(COLUMNS.map((c) => c.id))
// `OTHER_COLUMN` — the catch-all for a status outside the canonical 7, so such a
// task isn't silently dropped — lives in `boardAnnouncements` alongside the
// label mapping the screen-reader announcements read, so the column and its
// spoken name can't drift apart.

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

/** Cost label that never rounds a real sub-cent charge to a misleading $0.000: a
 *  sub-cent cost shows 4 decimals ($0.0004), ≥1¢ shows cents ($0.42), exactly 0 → $0.000. */
function formatCostUsd(c: number): string {
  if (c === 0) return '$0.000'
  if (c < 0.01) return `$${c.toFixed(4)}`
  return `$${c.toFixed(2)}`
}

function TaskCard({ task, onClick }: { task: BoardTask; onClick: () => void }) {
  const runtime = String(task['assigneeRuntime'] ?? 'openclaw')
  const cost = typeof task['costUsd'] === 'number' ? (task['costUsd'] as number) : null
  const verdict = verdictStatus(task)
  return (
    <button
      type="button"
      data-testid="board-card"
      onClick={onClick}
      className="group block w-full cursor-pointer rounded-2xl border border-border bg-surface p-4 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <div
        className="text-[13px] font-semibold text-foreground"
        style={{ lineHeight: 1.35, letterSpacing: '-0.01em', marginBottom: 9 }}
      >
        {task.title ?? '(untitled)'}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone="idle" label={runtime} />
        {verdict && (
          <StatusPill tone={VERDICT_META[verdict].tone} label={VERDICT_META[verdict].label} />
        )}
        {cost != null && (
          <span className="font-data text-[11px] text-foreground/50">{formatCostUsd(cost)}</span>
        )}
        {task['parentTaskId'] ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <CornerDownRight size={11} strokeWidth={2} /> sub
          </span>
        ) : null}
      </div>
    </button>
  )
}

// Columns are large targets, so pointer position is the most predictable hit test;
// fall back to rect intersection for keyboard drags (which have no pointer coords).
const boardCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length ? hits : rectIntersection(args)
}

// A card wrapped for drag-and-drop. The card body keeps its click-to-open behavior;
// a dedicated grip handle is the drag activator (so dragging never competes with the
// open-drawer click, and keyboard pickup — Space/arrows/Space — has a clear, labelled
// target). Terminal / off-list cards pass `disabled` and render no handle.
function DraggableCard({
  task,
  disabled,
  onOpen,
}: {
  task: BoardTask
  disabled: boolean
  onOpen: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    // `title` rides along so the screen-reader announcements can name the card
    // without reaching back into `effectiveTasks` — see boardAnnouncements.ts
    // for why a closure over board state is unsafe at announcement time.
    data: { fromStatus: task.status, title: task.title ?? '(untitled)' },
    disabled,
  })
  return (
    <div ref={setNodeRef} className="group/card relative" style={{ opacity: isDragging ? 0.4 : 1 }}>
      <TaskCard task={task} onClick={onOpen} />
      {!disabled && (
        <button
          type="button"
          aria-label={`Drag to move “${task.title ?? 'task'}” to another column`}
          className="absolute right-1.5 top-1.5 flex h-6 w-6 cursor-grab items-center justify-center rounded-md text-foreground/30 opacity-0 transition hover:bg-foreground/[0.08] hover:text-foreground/60 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing group-hover/card:opacity-100"
          style={{ touchAction: 'none' }}
          {...listeners}
          {...attributes}
        >
          <GripVertical size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

// A status column that is also a drop target. `dropDisabled` turns off the column
// mid-drag when the active card can't legally move here, so illegal targets don't
// highlight or accept a drop (the server-legal transitions come from boardStatus).
function BoardColumn({
  col,
  items,
  dropDisabled,
  cardDisabled,
  onCardOpen,
}: {
  col: { id: string; label: string }
  items: BoardTask[]
  dropDisabled: boolean
  cardDisabled: (task: BoardTask) => boolean
  onCardOpen: (id: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id, disabled: dropDisabled })
  return (
    <div
      ref={setNodeRef}
      data-testid={`board-column-${col.id}`}
      className={[
        'flex w-[264px] shrink-0 flex-col gap-2.5 rounded-2xl border p-3 transition-colors',
        isOver && !dropDisabled
          ? 'border-primary bg-primary/[0.05]'
          : 'border-border bg-foreground/[0.02]',
      ].join(' ')}
    >
      <div className="flex items-center justify-between px-1">
        <span className={SECTION_LABEL}>{col.label}</span>
        <span className="font-data rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-semibold text-foreground/50">
          {items.length}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {items.map((t, i) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
          >
            <DraggableCard task={t} disabled={cardDisabled(t)} onOpen={() => onCardOpen(t.id)} />
          </motion.div>
        ))}
        {items.length === 0 && (
          <div className="py-3.5 text-center text-[11px] text-muted-foreground">No tasks</div>
        )}
      </div>
    </div>
  )
}

export function BoardPanel() {
  const teams = useTeamStore((s) => s.teams)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)

  const [teamFilter, setTeamFilter] = useState<string>(selectedTeamId ?? 'all')
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false) // false until the first fetch resolves → skeleton
  const [fetchOk, setFetchOk] = useState(true) // false when the last fetch failed → error/retry
  // Mirrors `loaded` for the refresh closure so `refresh` stays dep-stable
  // (`[teamFilter]`) and the 5s poll doesn't re-create the interval each load.
  const loadedRef = useRef(false)
  // Reads overlap by design here (the 5s poll, Refresh/Retry, the post-create reconcile)
  // and a local commit can land between a GET being issued and its response arriving, so
  // the board snapshot is sequenced last-write-wins. See useReadSequencer for the two
  // staleness rules; the drag path is exactly why a plain generation counter isn't enough.
  const reads = useReadSequencer()

  // Optimistic drag moves: taskId → target status, laid on top of `tasks` so the card
  // sits in its new column while the PATCH is in flight. Short-lived — cleared the
  // moment the mutation resolves (committed into `tasks` on success, or rolled back).
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [activeTask, setActiveTask] = useState<BoardTask | null>(null)
  const mutate = useStatusMutation()
  const sensors = useSensors(
    // Grip-handle drags only. distance:5 → a stationary press on the handle doesn't
    // start a drag, and the card body's click-to-open is never intercepted (the handle
    // is a separate element, so click vs. drag don't compete).
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Keyboard DnD: focus a handle, Space to pick up, arrows to move, Space to drop,
    // Esc to cancel. Uses the default coordinate getter (25px/arrow, resolved via the
    // rectIntersection fallback); crisp column-to-column snapping is a follow-up.
    useSensor(KeyboardSensor),
  )

  const refresh = useCallback(async () => {
    // Claimed synchronously, before the await — so `handleCreated`'s optimistic
    // prepend and its reconcile read invalidate any in-flight read in the same tick.
    const read = reads.beginRead()
    setRefreshing(true)
    try {
      const res = await fetchBoardResult(teamFilter === 'all' ? undefined : teamFilter)
      // Superseded by a newer read, or by a local commit made after this read was
      // issued → a stale snapshot. Drop it rather than reverting newer state; the
      // next poll (≤5s) reconciles against a response that saw the commit.
      if (!read.isCurrent()) return
      if (res.ok) {
        setTasks(res.tasks)
        setFetchOk(true)
      } else if (!loadedRef.current) {
        // INITIAL load failed → show the error/retry screen.
        setTasks([])
        setFetchOk(false)
      }
      // A transient poll failure AFTER a good load keeps the last good snapshot —
      // don't blank a populated, actively-watched board to the error screen.
    } finally {
      // A `return` above still runs this, so the loading chrome needs its own guard:
      // an older read must neither clear the spinner while a newer read is still
      // running, nor dismiss the skeleton on a team-filter switch (which would flash
      // the previous team's tasks). `isNewestRead` (not `isCurrent`) on purpose — see
      // useReadSequencer. The newest read always resolves (`fetchBoardResult` never
      // throws), so `loaded` can't get stuck.
      if (read.isNewestRead()) {
        setRefreshing(false)
        setLoaded(true)
        loadedRef.current = true
      }
    }
  }, [teamFilter, reads])

  useEffect(() => {
    setLoaded(false) // a team-filter change re-enters the loading state
    loadedRef.current = false
    void refresh()
  }, [refresh])

  useVisiblePolling(() => void refresh(), 5000)

  // A manually-created task: show it instantly (optimistic prepend) unless the
  // active team filter would exclude it, then reconcile against the server. The
  // authoritative `refresh` corrects any drift (e.g. server-assigned fields).
  const handleCreated = useCallback(
    (task: BoardTask) => {
      const matchesFilter = teamFilter === 'all' || task.teamId === teamFilter
      if (matchesFilter) {
        reads.commitLocalWrite() // a read already in flight predates this prepend
        setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]))
      }
      void refresh()
    },
    [teamFilter, refresh, reads],
  )

  // Tasks with any in-flight optimistic drag move applied, so the board (and the 5s
  // poll) keep the moved card in its target column until the server confirms.
  const effectiveTasks = useMemo(
    () =>
      Object.keys(overrides).length === 0
        ? tasks
        : tasks.map((t) => (overrides[t.id] ? { ...t, status: overrides[t.id]! } : t)),
    [tasks, overrides],
  )

  const byStatus = useMemo(() => {
    const map: Record<string, BoardTask[]> = {}
    for (const col of COLUMNS) map[col.id] = []
    const other: BoardTask[] = []
    for (const t of effectiveTasks) {
      if (COLUMN_IDS.has(t.status)) (map[t.status] ??= []).push(t)
      else other.push(t)
    }
    if (other.length) map[OTHER_COLUMN.id] = other
    return map
  }, [effectiveTasks])

  // Append the catch-all "Other" column only when an off-list status appears.
  const columns = useMemo(
    () => (byStatus[OTHER_COLUMN.id]?.length ? [...COLUMNS, OTHER_COLUMN] : COLUMNS),
    [byStatus],
  )

  const onDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      setActiveTask(effectiveTasks.find((t) => t.id === active.id) ?? null)
    },
    [effectiveTasks],
  )

  // Resolve the drop to a status move and commit it through the SAME shared mutation
  // the drawer editor uses (legal-transition guard + agent-release confirm + rollback
  // + toast). The override only bridges the in-flight PATCH; on success the move is
  // committed into `tasks` and the override dropped, so the poll stays authoritative
  // (if the server later advances the task further, the next poll simply shows that).
  const clearOverride = useCallback(
    (taskId: string) =>
      setOverrides((o) => {
        if (!(taskId in o)) return o
        const n = { ...o }
        delete n[taskId]
        return n
      }),
    [],
  )

  const onDragEnd = useCallback(
    async ({ active, over }: DragEndEvent) => {
      setActiveTask(null)
      const move = resolveDrop(String(active.id), over ? String(over.id) : null, effectiveTasks)
      if (!move) return
      const task = effectiveTasks.find((t) => t.id === move.taskId)
      const ok = await mutate({
        taskId: move.taskId,
        from: move.from,
        to: move.to,
        assigneeAgentId: (task?.assigneeAgentId as string | null | undefined) ?? null,
        applyOptimistic: () => setOverrides((o) => ({ ...o, [move.taskId]: move.to })),
        rollback: () => clearOverride(move.taskId),
      })
      if (ok) {
        // The override bridged the in-flight PATCH (it layers over `tasks`, so no read
        // could clobber it). Clearing it hands authority back to `tasks`, so the commit
        // must also fence off any read issued before this point — otherwise that read
        // lands with the pre-drag status and snaps the card back to its old column.
        reads.commitLocalWrite()
        setTasks((prev) => prev.map((t) => (t.id === move.taskId ? { ...t, status: move.to } : t)))
        clearOverride(move.taskId)
      }
    },
    [effectiveTasks, mutate, clearOverride, reads],
  )

  // Mid-drag, a card may only land on a column it can legally transition to; all other
  // columns are disabled as drop targets (so they neither highlight nor accept a drop).
  const columnDropDisabled = useCallback(
    (columnId: string) =>
      activeTask != null &&
      activeTask.status !== columnId &&
      !canTransition(activeTask.status, columnId),
    [activeTask],
  )

  // Draggable only when the card has at least one legal target — so terminal
  // (done/cancelled) and off-list "Other" cards can't be dragged into illegal states.
  const cardDisabled = useCallback((task: BoardTask) => statusOptions(task.status).length <= 1, [])

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Board"
        icon={KanbanSquare}
        size="md"
        border
        actions={
          <>
            <span className={COUNT_PILL}>{tasks.length} tasks</span>
            <Select
              size="sm"
              aria-label="Filter by team"
              value={teamFilter}
              onChange={(value) => setTeamFilter(value)}
            >
              <option value="all">All teams</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.icon} {t.name}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
              aria-label="Refresh"
            >
              {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} strokeWidth={2} />}
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => setComposerOpen(true)}>
              <Plus size={14} strokeWidth={2.4} />
              New task
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      {/* The board is a live projection of agent work — cards are created and
          moved by agents through chat. A Kanban invites drag/create, so without a
          word this reads as broken rather than intentional. This one-liner sets
          the expectation the moment the board opens, while the header's New-task
          button and the drawer's status editor make the manual path real. */}
      <div
        data-testid="board-agent-hint"
        className="flex items-center gap-2 border-b border-border px-6 py-2 text-[12px] text-foreground/50"
      >
        <Bot size={13} strokeWidth={2} className="shrink-0 text-foreground/40" />
        <span>
          AI agents continuously create and move work.{' '}
          <span className="text-foreground/35">You can also manage tasks manually.</span>
        </span>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        <DndContext
          sensors={sensors}
          collisionDetection={boardCollision}
          // Replaces dnd-kit's defaults, which announce raw task uuids and raw
          // status ids. Module constants → stable identity → the internal
          // useDndMonitor never re-registers.
          accessibility={BOARD_ACCESSIBILITY}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveTask(null)}
        >
          <div className="flex min-h-full items-start gap-4">
            {/* Approvals are decoupled from the board-task fetch (an exec store + a
              /api/tools/approvals poll), so this column ALWAYS renders as the first
              column — a /api/board outage never hides a pending, time-sensitive gate.
              Scoped to the team filter; a rail when empty, auto-expands on a new gate. */}
            <ApprovalsColumn teamFilter={teamFilter} />
            {!loaded ? (
              // Skeleton columns until the first fetch resolves (mirrors the
              // RuntimesPanel `!loaded` pattern — empty columns shouldn't flash first).
              <div
                data-testid="board-skeleton"
                style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}
              >
                {COLUMNS.map((col) => (
                  <div
                    key={col.id}
                    style={{ flex: '0 0 264px', display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    <Skeleton width="50%" height={11} />
                    <Skeleton height={72} radius={16} />
                    <Skeleton height={72} radius={16} />
                  </div>
                ))}
              </div>
            ) : !fetchOk ? (
              // The fetch FAILED — distinct from a genuinely empty board (which would
              // otherwise show "No tasks" in every column with no hint of an error).
              <div data-testid="board-fetch-error" className="max-w-[460px]">
                <FormattedAlert tone="error">
                  <span className="flex items-center gap-2">
                    Couldn’t load the board.
                    <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                      Retry
                    </Button>
                  </span>
                </FormattedAlert>
              </div>
            ) : tasks.length === 0 ? (
              // A genuinely empty board (fetch OK, zero tasks) → one board-level
              // empty state with a manual CTA, rather than seven identical "No
              // tasks" columns. Reinforces the agent-driven model and offers the
              // manual escape hatch in the same place a first-time user looks.
              <div
                data-testid="board-empty"
                className="flex flex-1 items-center justify-center py-16"
              >
                <EmptyState
                  icon={Sparkles}
                  tone="primary"
                  title="No tasks yet"
                  helper="Agents populate this board automatically as work is delegated in chat. You can also add the first task yourself."
                  action={
                    <Button variant="primary" size="sm" onClick={() => setComposerOpen(true)}>
                      <Plus size={14} strokeWidth={2.4} /> New task
                    </Button>
                  }
                />
              </div>
            ) : (
              columns.map((col) => (
                <BoardColumn
                  key={col.id}
                  col={col}
                  items={byStatus[col.id] ?? []}
                  dropDisabled={columnDropDisabled(col.id)}
                  cardDisabled={cardDisabled}
                  onCardOpen={setOpenTaskId}
                />
              ))
            )}
          </div>
          {/* Rendered in an overlay so the moving card isn't clipped by column
              overflow, and follows the pointer/keyboard cursor across columns. */}
          <DragOverlay>
            {activeTask ? (
              <div className="w-[240px] cursor-grabbing">
                <TaskCard task={activeTask} onClick={() => {}} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <AnimatePresence>
        {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
      </AnimatePresence>

      <NewTaskDialog
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        defaultTeamId={teamFilter !== 'all' ? teamFilter : undefined}
        onCreated={handleCreated}
      />
    </div>
  )
}
