import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CornerDownRight, KanbanSquare, RefreshCw } from 'lucide-react'

import { useTeamStore } from '@/stores/team'
import { fetchBoardResult, type BoardTask } from '@/lib/boardClient'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Skeleton } from '@/features/shared/Skeleton'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'
import { ENTER_SPRING, listDelay } from '@/lib/motion'

import { TaskDetailDrawer } from './TaskDetailDrawer'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

const COLUMNS: { id: string; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'in_review', label: 'In review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
]
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

function TaskCard({ task, onClick }: { task: BoardTask; onClick: () => void }) {
  const runtime = String(task['assigneeRuntime'] ?? 'openclaw')
  const cost = typeof task['costUsd'] === 'number' ? (task['costUsd'] as number) : null
  const verdict = verdictStatus(task)
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      data-testid="board-card"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="surface-raised-tier"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        borderRadius: 10,
        padding: '9px 11px',
        cursor: 'pointer',
        boxShadow: hovered ? 'var(--shadow-floating)' : undefined,
        borderColor: hovered ? 'var(--border-floating)' : undefined,
        background: hovered ? 'rgb(var(--foreground-rgb) / 0.03)' : undefined,
        transition:
          'box-shadow var(--motion-fast), border-color var(--motion-fast), background var(--motion-fast)',
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--foreground)',
          lineHeight: 1.35,
          marginBottom: 7,
        }}
      >
        {task.title ?? '(untitled)'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <StatusPill tone="idle" label={runtime} />
        {verdict && (
          <StatusPill tone={VERDICT_META[verdict].tone} label={VERDICT_META[verdict].label} />
        )}
        {cost != null && (
          <span className="font-data" style={{ fontSize: 11, color: muted(0.5) }}>
            ${cost.toFixed(3)}
          </span>
        )}
        {task['parentTaskId'] ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 11,
              color: muted(0.4),
            }}
          >
            <CornerDownRight size={11} /> sub
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KanbanSquare size={15} style={{ color: 'var(--mint)' }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            Board
          </span>
          <span
            className="font-data"
            style={{
              fontSize: 11,
              color: 'var(--primary)',
              background: 'rgb(var(--primary-rgb) / 0.12)',
              borderRadius: 20,
              padding: '2px 8px',
            }}
          >
            {tasks.length} tasks
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 30,
              padding: '0 10px',
              borderRadius: 7,
              fontSize: 11,
              color: muted(0.5),
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              transition: 'background var(--motion-fast), color var(--motion-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.05)'
              e.currentTarget.style.color = 'var(--foreground)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = muted(0.5)
            }}
          >
            {refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />} Refresh
          </button>
          <GitHubStarButton />
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {!loaded ? (
          // Skeleton columns until the first fetch resolves (mirrors the
          // RuntimesPanel `!loaded` pattern — empty columns shouldn't flash first).
          <div
            data-testid="board-skeleton"
            style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}
          >
            {COLUMNS.map((col) => (
              <div
                key={col.id}
                style={{ flex: '0 0 240px', display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <Skeleton width="50%" height={11} />
                <Skeleton height={56} radius={10} />
                <Skeleton height={56} radius={10} />
              </div>
            ))}
          </div>
        ) : !fetchOk ? (
          // The fetch FAILED — distinct from a genuinely empty board (which would
          // otherwise show "No tasks" in every column with no hint of an error).
          <div data-testid="board-fetch-error" style={{ maxWidth: 460 }}>
            <FormattedAlert tone="error">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Couldn’t load the board.
                <button
                  type="button"
                  onClick={() => void refresh()}
                  style={{ textDecoration: 'underline', cursor: 'pointer', color: 'inherit' }}
                >
                  Retry
                </button>
              </span>
            </FormattedAlert>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, minHeight: '100%', alignItems: 'flex-start' }}>
            {columns.map((col) => {
              const items = byStatus[col.id] ?? []
              return (
                <div
                  key={col.id}
                  data-testid={`board-column-${col.id}`}
                  style={{ flex: '0 0 240px', display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0 2px',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: muted(0.6),
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {col.label}
                    </span>
                    <span style={{ fontSize: 10, color: muted(0.35) }}>{items.length}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
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
                      <div
                        style={{
                          fontSize: 11,
                          color: muted(0.3),
                          padding: '12px 2px',
                          textAlign: 'center',
                        }}
                      >
                        No tasks
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <AnimatePresence>
        {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
      </AnimatePresence>
    </div>
  )
}
