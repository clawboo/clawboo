// The agent-detail Workspace tab: a read-only view of the agent's task
// worktree. Three parts and nothing else: the file tree with change badges,
// the now line (the file and command the agent most recently touched, from the
// obs tail), and a right pane showing the selected file's diff or content.
//
// Refresh strategy, in the order the research settled on: git status is
// event-invalidated off tool_call events (the stream already carries the
// paths) with a visible-tab poll as the level-triggered backstop; directory
// listings load lazily and reload only when a touched path sits inside an
// expanded directory.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, FileText } from 'lucide-react'

import { useObsStream } from '@/features/obs/useObsStream'
import { useFleetStore } from '@/stores/fleet'
import { useVisiblePolling } from '@/lib/useVisiblePolling'
import { Spinner } from '@/features/shared/Spinner'
import {
  getAgentWorkspaces,
  getWorkspaceFile,
  getWorkspaceFileDiff,
  getWorkspaceStatus,
  getWorkspaceTree,
  statusBadge,
  type AgentWorkspace,
  type WorkspaceStatusEntry,
  type WorkspaceTreeEntry,
} from '@/lib/workspaceClient'
import { deriveNowActivity, toWorkspaceRelPath } from './deriveNowActivity'

const STATUS_POLL_MS = 10_000
const WORKSPACES_POLL_MS = 15_000
/** Debounce between a tool_call landing and the status/tree refetch. */
const EVENT_INVALIDATE_MS = 1500
/** Ancestors of at most this many changed files are auto-expanded on load. */
const AUTO_EXPAND_PATHS = 8

/** Deleted paths whose parent directory is `dir`. They are absent from the
 *  listing by definition, so the tree has to synthesize their rows. */
function deletedIn(statusByPath: Map<string, WorkspaceStatusEntry>, dir: string): string[] {
  const out: string[] = []
  for (const [p, entry] of statusByPath) {
    if (statusBadge(entry) !== 'D') continue
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (parent === dir) out.push(p)
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

const badgeColor = (badge: string): string =>
  badge === 'A' ? 'var(--mint)' : badge === 'D' ? 'var(--primary)' : 'var(--amber)'

// ─── File tree ───────────────────────────────────────────────────────────────

interface TreeDirState {
  entries: WorkspaceTreeEntry[]
  truncated: boolean
  /** The listing request failed. Rendered as a retry row, never as "empty". */
  failed?: boolean
}

function TreeLevel({
  taskId,
  dir,
  depth,
  dirs,
  expanded,
  statusByPath,
  selectedPath,
  onToggleDir,
  onSelectFile,
  onRetryDir,
}: {
  taskId: string
  dir: string
  depth: number
  dirs: Map<string, TreeDirState>
  expanded: Set<string>
  statusByPath: Map<string, WorkspaceStatusEntry>
  selectedPath: string | null
  onToggleDir: (dir: string) => void
  onSelectFile: (path: string) => void
  onRetryDir: (dir: string) => void
}) {
  const state = dirs.get(dir)
  if (!state) {
    return (
      <div
        className="flex items-center gap-2 py-1 font-mono text-[12px] text-muted-foreground"
        style={{ paddingLeft: 12 + depth * 14 }}
      >
        <Spinner size={10} />
        Loading…
      </div>
    )
  }
  if (state.failed) {
    return (
      <button
        type="button"
        onClick={() => onRetryDir(dir)}
        className="flex w-full cursor-pointer items-center gap-2 py-1 pr-3 text-left font-mono text-[12px] text-amber transition-colors hover:text-foreground"
        style={{ paddingLeft: 12 + depth * 14 }}
      >
        Could not list this folder. Retry
      </button>
    )
  }
  return (
    <>
      {state.entries.map((entry) => {
        const rel = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.kind === 'dir') {
          const isOpen = expanded.has(rel)
          return (
            <div key={rel}>
              <button
                type="button"
                onClick={() => onToggleDir(rel)}
                className="flex w-full cursor-pointer items-center gap-1.5 py-1 pr-3 text-left font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                style={{ paddingLeft: 12 + depth * 14 }}
              >
                {isOpen ? (
                  <ChevronDown size={12} strokeWidth={2.5} className="shrink-0" />
                ) : (
                  <ChevronRight size={12} strokeWidth={2.5} className="shrink-0" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
              {isOpen && (
                <TreeLevel
                  taskId={taskId}
                  dir={rel}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  statusByPath={statusByPath}
                  selectedPath={selectedPath}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                  onRetryDir={onRetryDir}
                />
              )}
            </div>
          )
        }
        const st = statusByPath.get(rel)
        const badge = st ? statusBadge(st) : null
        const isSelected = selectedPath === rel
        return (
          <button
            key={rel}
            type="button"
            onClick={() => onSelectFile(rel)}
            className={[
              'flex w-full cursor-pointer items-center gap-2 py-1 pr-3 text-left font-mono text-[12px] transition-colors',
              isSelected
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
            style={{
              paddingLeft: 12 + depth * 14 + 18,
              borderLeft: isSelected ? '2px solid var(--primary)' : '2px solid transparent',
            }}
          >
            <span className="truncate">{entry.name}</span>
            {badge && (
              <span
                className="ml-auto shrink-0 font-mono text-[11px]"
                style={{ color: badgeColor(badge) }}
                title={st?.origPath ? `renamed from ${st.origPath}` : undefined}
              >
                {badge}
              </span>
            )}
          </button>
        )
      })}
      {/* Files git reports as DELETED are gone from the listing, so without a
          tombstone they were counted in "N changed" and then unreachable: the
          user could see the number but never the diff that explains it. */}
      {deletedIn(statusByPath, dir).map((rel) => {
        const name = rel.slice(dir ? dir.length + 1 : 0)
        const isSelected = selectedPath === rel
        return (
          <button
            key={rel}
            type="button"
            onClick={() => onSelectFile(rel)}
            className={[
              'flex w-full cursor-pointer items-center gap-2 py-1 pr-3 text-left font-mono text-[12px] line-through transition-colors',
              isSelected
                ? 'bg-primary/10 text-foreground'
                : 'text-foreground/40 hover:text-foreground/70',
            ].join(' ')}
            style={{
              paddingLeft: 12 + depth * 14 + 18,
              borderLeft: isSelected ? '2px solid var(--primary)' : '2px solid transparent',
            }}
          >
            <span className="truncate">{name}</span>
            <span
              className="ml-auto shrink-0 font-mono text-[11px]"
              style={{ color: 'var(--primary)' }}
            >
              D
            </span>
          </button>
        )
      })}
      {state.truncated && (
        <div
          className="py-1 font-mono text-[11px] text-foreground/40"
          style={{ paddingLeft: 12 + depth * 14 + 18 }}
        >
          … more entries not shown
        </div>
      )}
    </>
  )
}

// ─── Right pane: diff or content ─────────────────────────────────────────────

function diffLineStyle(line: string): CSSProperties {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return { background: 'rgb(var(--mint-rgb) / 0.10)', color: 'var(--mint)' }
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return { background: 'rgb(var(--primary-rgb) / 0.10)', color: 'var(--primary)' }
  }
  if (line.startsWith('@@')) return { color: 'var(--violet)' }
  return {}
}

function FilePane({
  taskId,
  path,
  changed,
  refreshKey,
  onViewKind,
}: {
  taskId: string
  path: string
  changed: boolean
  /** Reports which view actually rendered, so the header label cannot claim
   *  "Diff" while showing content (an untracked file counts as changed but has
   *  an empty diff, and falls back to content). */
  onViewKind: (kind: 'diff' | 'file') => void
  /** Bumped when the workspace status is re-read, so an open file follows the
   *  agent's edits instead of freezing at the version opened. */
  refreshKey: number
}) {
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<
    | { kind: 'diff'; diff: string; truncated: boolean }
    | { kind: 'content'; content: string; truncated: boolean }
    | { kind: 'binary'; size: number }
    | { kind: 'error' }
    | null
  >(null)

  // `first` distinguishes opening a file from re-reading it: only the initial
  // open shows the spinner, so a background refresh does not flash the pane.
  const first = useRef(true)
  useEffect(() => {
    let cancelled = false
    if (first.current) {
      setLoading(true)
      setView(null)
    }
    void (async () => {
      // A changed file shows its diff; an unchanged or untracked one (empty
      // diff) falls back to content.
      if (changed) {
        const d = await getWorkspaceFileDiff(taskId, path)
        if (cancelled) return
        if (d && d.diff.trim()) {
          setView({ kind: 'diff', diff: d.diff, truncated: d.truncated })
          onViewKind('diff')
          setLoading(false)
          first.current = false
          return
        }
      }
      const f = await getWorkspaceFile(taskId, path)
      if (cancelled) return
      if (!f) setView({ kind: 'error' })
      else if (f.binary) setView({ kind: 'binary', size: f.size })
      else setView({ kind: 'content', content: f.content, truncated: f.truncated })
      onViewKind('file')
      setLoading(false)
      first.current = false
    })()
    return () => {
      cancelled = true
    }
    // `onViewKind` is intentionally NOT a dependency: it is a reporting
    // callback, and including it would refetch whenever the parent re-renders.
  }, [taskId, path, changed, refreshKey])

  // A DIFFERENT file is a fresh open, not a refresh.
  useEffect(() => {
    first.current = true
  }, [taskId, path])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-foreground/40">
        <Spinner size={12} />
        Loading…
      </div>
    )
  }
  if (!view || view.kind === 'error') {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-foreground/40">
        Could not read this file.
      </div>
    )
  }
  if (view.kind === 'binary') {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-foreground/40">
        Binary file · {view.size.toLocaleString()} bytes
      </div>
    )
  }
  const lines = (view.kind === 'diff' ? view.diff : view.content).split('\n')
  return (
    <div className="h-full overflow-auto font-mono text-[12px] leading-[20px]">
      <div className="min-w-max py-2">
        {lines.map((line, i) => (
          <div
            key={i}
            className="whitespace-pre px-3"
            style={view.kind === 'diff' ? diffLineStyle(line) : undefined}
          >
            {line || ' '}
          </div>
        ))}
        {view.truncated && (
          <div className="px-3 py-1 text-[11px] text-foreground/40">… truncated</div>
        )}
      </div>
    </div>
  )
}

// ─── The panel ───────────────────────────────────────────────────────────────

export function WorkspacePanel({
  agentId,
  pinnedTaskId,
}: {
  agentId: string
  /** Show exactly this task's workspace and hide the picker. Set by hosts that
   *  already scope the view to one task (the board's task drawer), where the
   *  agent-wide list would let the user navigate away from the task they opened. */
  pinnedTaskId?: string
}) {
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[] | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(pinnedTaskId ?? null)
  const [dirs, setDirs] = useState<Map<string, TreeDirState>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<WorkspaceStatusEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [viewKind, setViewKind] = useState<'diff' | 'file'>('file')

  const agent = useFleetStore((s) => s.agents.find((a) => a.id === agentId) ?? null)
  const running = agent?.status === 'running'

  // The selection is PINNED to a task id, never positional. The list arrives
  // ordered by updatedAt DESC, so resolving `active` as workspaces[0] meant any
  // other task touching the board reordered the list and swapped the user's
  // tree and open file out from under them on the next poll.
  const active = useMemo(() => {
    if (!workspaces || workspaces.length === 0) return null
    return workspaces.find((w) => w.taskId === selectedTaskId) ?? null
  }, [workspaces, selectedTaskId])
  const taskId = active?.taskId ?? null
  const onDisk = active?.onDisk ?? false

  // ── Workspace list: load + slow poll (tasks claim/complete over minutes) ──
  const loadWorkspaces = useCallback(() => {
    void getAgentWorkspaces(agentId).then((ws) => {
      // `null` is a FAILED request. Keeping the previous list is what stops one
      // dropped poll from emptying the panel over a live worktree.
      if (ws) setWorkspaces(ws)
    })
  }, [agentId])
  useEffect(() => {
    setWorkspaces(null)
    setSelectedTaskId(pinnedTaskId ?? null)
    loadWorkspaces()
  }, [loadWorkspaces, pinnedTaskId])
  useVisiblePolling(loadWorkspaces, WORKSPACES_POLL_MS)

  // Pin the default once, and re-pin only when the pinned task leaves the list.
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return
    // A pinned host owns the selection outright. Falling back to workspaces[0]
    // here would silently show a DIFFERENT task's tree under the drawer's
    // header the moment the pinned task is missing from the list.
    if (pinnedTaskId) return
    const stillThere = selectedTaskId && workspaces.some((w) => w.taskId === selectedTaskId)
    if (!stillThere) setSelectedTaskId(workspaces[0]?.taskId ?? null)
  }, [workspaces, selectedTaskId, pinnedTaskId])

  // ── Tree + status per selected workspace ──────────────────────────────────
  // Every response is stamped with the workspace it was requested for. Without
  // this, a slow listing for the PREVIOUS workspace lands after a switch and
  // paints the wrong tree and badges under the new workspace's header.
  const activeTaskRef = useRef<string | null>(null)
  activeTaskRef.current = taskId

  const loadDir = useCallback((tid: string, dir: string) => {
    void getWorkspaceTree(tid, dir).then((listing) => {
      if (activeTaskRef.current !== tid) return // stale: workspace switched
      setDirs((prev) => {
        const next = new Map(prev)
        next.set(
          dir,
          listing
            ? { entries: listing.entries, truncated: listing.truncated }
            : { entries: [], truncated: false, failed: true },
        )
        return next
      })
    })
  }, [])

  const [statusUnreadable, setStatusUnreadable] = useState(false)
  // Bumped on every applied status refresh, so the open file re-reads its diff
  // as the agent keeps editing it.
  const [statusGen, setStatusGen] = useState(0)

  const refreshStatus = useCallback(() => {
    const tid = taskId
    if (!tid || !onDisk) return
    void getWorkspaceStatus(tid).then((res) => {
      if (activeTaskRef.current !== tid) return // stale
      if (res.ok) {
        setStatus(res.status.entries)
        setStatusUnreadable(false)
      } else if (res.unreadable) {
        // git refused the checkout. Say so rather than rendering a clean tree.
        setStatusUnreadable(true)
      }
      setStatusGen((g) => g + 1)
    })
  }, [taskId, onDisk])

  useEffect(() => {
    setDirs(new Map())
    setExpanded(new Set())
    setStatus([])
    setStatusUnreadable(false)
    setSelectedPath(null)
    if (!taskId || !onDisk) return
    loadDir(taskId, '')
    refreshStatus()
  }, [taskId, onDisk, loadDir, refreshStatus])

  // The level-triggered backstop behind the event-driven refresh below.
  useVisiblePolling(refreshStatus, STATUS_POLL_MS, { enabled: Boolean(taskId && onDisk) })

  // Auto-expand ancestors of the first few changed files so change badges are
  // visible without hunting. Runs when status first arrives for a workspace.
  const autoExpandedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!taskId || status.length === 0 || autoExpandedFor.current === taskId) return
    autoExpandedFor.current = taskId
    const dirsToOpen = new Set<string>()
    for (const entry of status.slice(0, AUTO_EXPAND_PATHS)) {
      const parts = entry.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        dirsToOpen.add(parts.slice(0, i).join('/'))
      }
    }
    if (dirsToOpen.size === 0) return
    setExpanded((prev) => new Set([...prev, ...dirsToOpen]))
    for (const d of dirsToOpen) {
      if (!dirs.has(d)) loadDir(taskId, d)
    }
  }, [taskId, status, dirs, loadDir])

  const onToggleDir = useCallback(
    (dir: string) => {
      // The decision is made OUTSIDE the updater: a state updater must stay
      // pure, and React invokes it twice under StrictMode, which fired two
      // listing requests per expand.
      const willOpen = !expanded.has(dir)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (willOpen) next.add(dir)
        else next.delete(dir)
        return next
      })
      if (willOpen && taskId && !dirs.has(dir)) loadDir(taskId, dir)
    },
    [taskId, dirs, expanded, loadDir],
  )

  // ── Now line + event invalidation off the obs tail ────────────────────────
  const { events } = useObsStream({ agentId }, { limit: 80 })
  const now = useMemo(() => deriveNowActivity(events), [events])
  const worktreePath = active?.worktreePath ?? null
  const nowFileRel = now.file ? toWorkspaceRelPath(now.file.path, worktreePath) : null

  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSeenSeq = useRef(0)
  useEffect(() => {
    if (!taskId || !onDisk || events.length === 0) return
    // Scan the whole ARRIVED SLICE, not just the tail. Events land in batches,
    // and a tool_call is almost always followed by its tool_result, so
    // inspecting only the last event meant the qualifying call was never seen
    // and the tree stopped refreshing exactly while the agent was busy.
    const fresh = events.filter((e) => e.seq > lastSeenSeq.current)
    if (fresh.length === 0) return
    lastSeenSeq.current = Math.max(...fresh.map((e) => e.seq))
    const touched = deriveNowActivity(fresh)
    if (!fresh.some((e) => e.kind === 'tool_call')) return
    // Reschedule only on a qualifying batch; the cleanup is NOT tied to this
    // effect's re-runs, or an interleaved event would cancel the pending
    // refresh and starve invalidation under a busy stream.
    if (invalidateTimer.current) clearTimeout(invalidateTimer.current)
    invalidateTimer.current = setTimeout(() => {
      refreshStatus()
      // Reload the listing of the touched path's directory when it is loaded
      // already (a new file must appear without a full tree reload).
      const rel = touched.file ? toWorkspaceRelPath(touched.file.path, worktreePath) : null
      if (rel && rel.includes('/')) {
        const parent = rel.slice(0, rel.lastIndexOf('/'))
        if (dirs.has(parent)) loadDir(taskId, parent)
      } else if (rel) {
        loadDir(taskId, '')
      }
    }, EVENT_INVALIDATE_MS)
  }, [events, taskId, onDisk, worktreePath, dirs, loadDir, refreshStatus])

  // Unmount / workspace-switch cleanup for the pending invalidation timer.
  useEffect(() => {
    return () => {
      if (invalidateTimer.current) clearTimeout(invalidateTimer.current)
    }
  }, [taskId])

  // The obs cursor is per-AGENT: switching agents re-subscribes the stream and
  // restarts the tail, so a stale high-water mark would suppress every new
  // event until the new agent's seq caught up.
  useEffect(() => {
    lastSeenSeq.current = 0
  }, [agentId])

  const statusByPath = useMemo(() => {
    const m = new Map<string, WorkspaceStatusEntry>()
    for (const e of status) m.set(e.path, e)
    return m
  }, [status])

  const changedCount = status.length
  const selectedChanged = selectedPath ? statusByPath.has(selectedPath) : false

  // ── Empty states ──────────────────────────────────────────────────────────
  if (workspaces === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-foreground/40">
        <Spinner size={12} />
        Loading…
      </div>
    )
  }
  if (!active) {
    const isGateway = agent?.runtime === 'openclaw'
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText size={20} strokeWidth={1.5} className="text-foreground/25" />
        <div className="text-[12px] leading-relaxed text-muted-foreground">
          {isGateway
            ? 'This agent runs on the OpenClaw Gateway; its files live in the Gateway workspace, not in a local task worktree.'
            : 'No task workspace yet. When this agent takes a file-mutating board task, its worktree shows up here.'}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Workspace picker (only when there is a choice) + now line */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border bg-card/50 px-3 py-2">
        <span
          className={[
            'h-1.5 w-1.5 shrink-0 rounded-full',
            running ? 'bg-mint shadow-[0_0_6px_rgb(var(--mint-rgb)/0.6)]' : 'bg-foreground/25',
          ].join(' ')}
        />
        {nowFileRel ? (
          <>
            <span
              className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em]"
              style={{ color: running ? 'var(--mint)' : undefined }}
            >
              {running ? 'Editing' : 'Last file'}
            </span>
            <span className="truncate font-mono text-[12px] text-foreground" title={now.file?.path}>
              {nowFileRel}
            </span>
          </>
        ) : now.file ? (
          // The path resolved OUTSIDE this workspace (another repo, the agent's
          // own home). Showing it under "Editing" beside this workspace's tree
          // would claim the edit happened here.
          <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Working outside this workspace
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {running ? 'Working' : 'Idle'}
          </span>
        )}
        {now.command && (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber/25 bg-amber/10 px-2 py-0.5"
            title={now.command.command}
          >
            <span className="h-1 w-1 rounded-full bg-amber" />
            <span className="max-w-[180px] truncate font-mono text-[11px] text-amber">
              {now.command.command}
            </span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {changedCount > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {changedCount} changed
            </span>
          )}
          {!pinnedTaskId && workspaces.length > 1 && (
            <select
              value={active.taskId}
              onChange={(e) => setSelectedTaskId(e.target.value)}
              className="max-w-[200px] cursor-pointer rounded-md border border-border bg-input px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              aria-label="Workspace task"
            >
              {workspaces.map((w) => (
                <option key={w.taskId} value={w.taskId}>
                  {w.title}
                </option>
              ))}
            </select>
          )}
        </span>
      </div>

      {statusUnreadable && onDisk && (
        <div className="shrink-0 border-b border-amber/25 bg-amber/10 px-3 py-1.5 font-mono text-[11px] text-amber">
          Git cannot read this checkout, so changes are not shown. The worktree may have been
          orphaned by a repo move.
        </div>
      )}

      {!onDisk ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber">Paused</div>
          <div className="text-[12px] leading-relaxed text-muted-foreground">
            This workspace's checkout was paused or cleaned up. The branch
            {active.branch ? ` (${active.branch})` : ''} keeps the work; resuming the task restores
            the files.
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Tree */}
          <div className="w-[228px] shrink-0 overflow-y-auto border-r border-border py-1.5">
            <div
              className="truncate px-3 pb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/40"
              title={active.repoPath}
            >
              {active.branch ?? active.title}
            </div>
            <TreeLevel
              taskId={active.taskId}
              dir=""
              depth={0}
              dirs={dirs}
              expanded={expanded}
              statusByPath={statusByPath}
              selectedPath={selectedPath}
              onToggleDir={onToggleDir}
              onSelectFile={setSelectedPath}
              onRetryDir={(d) => loadDir(active.taskId, d)}
            />
          </div>
          {/* Right pane */}
          <div className="min-w-0 flex-1">
            {selectedPath ? (
              <div className="flex h-full flex-col">
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                  <span className="truncate font-mono text-[12px] text-foreground">
                    {selectedPath}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/40">
                    {viewKind === 'diff' ? 'Diff' : 'File'}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <FilePane
                    // REMOUNT on a task/path change. React runs a fiber's
                    // effects in declaration order, so the fetch effect (which
                    // reads `first.current`) runs before the reset effect that
                    // sets it, and the pane kept the previous file's view under
                    // the new file's name. `refreshKey` is deliberately absent:
                    // a background status refresh should not flash a spinner.
                    key={`${active.taskId}:${selectedPath}`}
                    taskId={active.taskId}
                    path={selectedPath}
                    changed={selectedChanged}
                    refreshKey={statusGen}
                    onViewKind={setViewKind}
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-foreground/40">
                Select a file to view its diff or content.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
