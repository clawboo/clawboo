import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Bot, CornerDownRight, KanbanSquare, Plus, RefreshCw, Sparkles } from 'lucide-react'

import { useTeamStore } from '@/stores/team'
import { fetchBoardResult, type BoardTask } from '@/lib/boardClient'
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
import { STATUS_LABEL, TASK_STATUSES } from './boardStatus'

const SECTION_LABEL =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45'
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
// A task with a status outside the canonical 7 lands here instead of being
// silently dropped (counted in the header but rendered nowhere).
const OTHER_COLUMN = { id: '__other__', label: 'Other' }

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
          <span className="inline-flex items-center gap-1 text-[11px] text-foreground/40">
            <CornerDownRight size={11} strokeWidth={2} /> sub
          </span>
        ) : null}
      </div>
    </button>
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

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetchBoardResult(teamFilter === 'all' ? undefined : teamFilter)
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
      setRefreshing(false)
      setLoaded(true)
      loadedRef.current = true
    }
  }, [teamFilter])

  useEffect(() => {
    setLoaded(false) // a team-filter change re-enters the loading state
    loadedRef.current = false
    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [refresh])

  // A manually-created task: show it instantly (optimistic prepend) unless the
  // active team filter would exclude it, then reconcile against the server. The
  // authoritative `refresh` corrects any drift (e.g. server-assigned fields).
  const handleCreated = useCallback(
    (task: BoardTask) => {
      const matchesFilter = teamFilter === 'all' || task.teamId === teamFilter
      if (matchesFilter) {
        setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]))
      }
      void refresh()
    },
    [teamFilter, refresh],
  )

  const byStatus = useMemo(() => {
    const map: Record<string, BoardTask[]> = {}
    for (const col of COLUMNS) map[col.id] = []
    const other: BoardTask[] = []
    for (const t of tasks) {
      if (COLUMN_IDS.has(t.status)) (map[t.status] ??= []).push(t)
      else other.push(t)
    }
    if (other.length) map[OTHER_COLUMN.id] = other
    return map
  }, [tasks])

  // Append the catch-all "Other" column only when an off-list status appears.
  const columns = useMemo(
    () => (byStatus[OTHER_COLUMN.id]?.length ? [...COLUMNS, OTHER_COLUMN] : COLUMNS),
    [byStatus],
  )

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
            columns.map((col) => {
              const items = byStatus[col.id] ?? []
              return (
                <div
                  key={col.id}
                  data-testid={`board-column-${col.id}`}
                  className="flex w-[264px] shrink-0 flex-col gap-2.5 rounded-2xl border border-border bg-foreground/[0.02] p-3"
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
                        <TaskCard task={t} onClick={() => setOpenTaskId(t.id)} />
                      </motion.div>
                    ))}
                    {items.length === 0 && (
                      <div className="py-3.5 text-center text-[11px] text-foreground/30">
                        No tasks
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
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
