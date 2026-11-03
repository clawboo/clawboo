// Browser alerts for what needs a person, raised while the tab is in the background.
//
// Two things are announced: a task an agent's work left waiting on a person (a
// run that failed or stopped responding, a task an agent marked blocked, work
// that did not pass its checks), and an agent waiting for an approval. Reasons
// a person caused (they pressed Stop, left a task without an agent, or moved
// the card to Blocked themselves) are not announced.
//
// The desktop app raises the same alerts natively (its needsYou.ts and
// approvals.ts watchers), so the copy and the rules here match it. Everything
// in this file is pure apart from `createAlertWatcher`, which only calls the
// functions it is handed.

import { taskAttentionOf } from '@/features/board/boardStatus'

export const ANNOUNCED_REASONS = ['failed', 'timed_out', 'blocked', 'needs_review'] as const
export type AnnouncedReason = (typeof ANNOUNCED_REASONS)[number]

const isAnnounced = (r: unknown): r is AnnouncedReason =>
  (ANNOUNCED_REASONS as readonly unknown[]).includes(r)

/** The obs event kinds after which what needs a person may have changed: a run
 *  ended, a task moved, an approval opened. Nothing else is worth a read. */
export const ALERT_TRIGGER_KINDS: ReadonlySet<string> = new Set([
  'execution_completed',
  'status_changed',
  'approval_requested',
])

/** The newest `seq` among the trigger events, or 0 when there is none. */
export function latestAlertTrigger(events: ReadonlyArray<{ seq: number; kind: string }>): number {
  let seq = 0
  for (const e of events) if (e.seq > seq && ALERT_TRIGGER_KINDS.has(e.kind)) seq = e.seq
  return seq
}

/** The fields of a board task the alerts read (GET /api/board rows). */
export interface AlertTaskInput {
  id: string
  title?: unknown
  status: string
  teamId?: unknown
  attention?: unknown
  updatedAt?: unknown
  personMovedAt?: unknown
}

/** The fields of a pending approval the alerts read, from either system. */
export interface AlertApprovalInput {
  id: string
  toolName: string
  agentId: string | null
  /** `exec` for a shell command; anything else is a tool call. */
  kind?: string | null
  expiresAt?: number | null
}

export type AlertItem =
  | {
      key: string
      kind: 'task'
      taskId: string
      title: string
      reason: AnnouncedReason
      teamId: string | null
    }
  | { key: string; kind: 'approval'; approvalId: string; toolName: string; agentId: string | null }

/** Moved to Blocked by a person, and nothing has moved it since: their own act. */
function blockedByPerson(task: AlertTaskInput): boolean {
  const moved = typeof task.personMovedAt === 'number' ? task.personMovedAt : null
  const updated = typeof task.updatedAt === 'number' ? task.updatedAt : 0
  return moved != null && moved >= updated
}

function titleOf(task: AlertTaskInput): string {
  return typeof task.title === 'string' && task.title.trim() ? task.title.trim() : 'A task'
}

/** What to announce in one read of the board and the approval queue. */
export function collectAlertItems(
  tasks: readonly AlertTaskInput[],
  approvals: readonly AlertApprovalInput[],
  now: number = Date.now(),
): AlertItem[] {
  const items: AlertItem[] = []
  const seenApprovals = new Set<string>()
  for (const a of approvals) {
    if (seenApprovals.has(a.id)) continue
    if (typeof a.expiresAt === 'number' && a.expiresAt <= now) continue
    seenApprovals.add(a.id)
    items.push({
      key: `approval:${a.id}`,
      kind: 'approval',
      approvalId: a.id,
      toolName: a.kind === 'exec' ? 'exec' : a.toolName,
      agentId: a.agentId,
    })
  }
  for (const t of tasks) {
    const attention = taskAttentionOf(t)
    if (!attention || !isAnnounced(attention.reason)) continue
    if (attention.reason === 'blocked' && blockedByPerson(t)) continue
    items.push({
      // Keyed by the reason too: a task that fails, is retried and fails again
      // is announced again once it has left the list in between.
      key: `task:${t.id}:${attention.reason}`,
      kind: 'task',
      taskId: t.id,
      title: titleOf(t),
      reason: attention.reason,
      teamId: typeof t.teamId === 'string' && t.teamId ? t.teamId : null,
    })
  }
  return items
}

/** Items not announced before, plus the updated seen set (only what is still
 *  waiting, so an item that leaves and comes back is new again). */
export function diffAlertItems(
  items: readonly AlertItem[],
  seen: ReadonlySet<string>,
): { fresh: AlertItem[]; seen: Set<string> } {
  return {
    fresh: items.filter((i) => !seen.has(i.key)),
    seen: new Set(items.map((i) => i.key)),
  }
}

// ─── Notice copy ─────────────────────────────────────────────────────────────

/** Where a click on the alert takes the person. */
export type AlertTarget =
  | { kind: 'task'; taskId: string; teamId: string | null }
  /** Needs you on the board. `teamId` is the team to show, `all` for every
   *  team, or null to keep the board's team as it is. */
  | { kind: 'needs-you'; teamId: string | null }

export interface AlertNotice {
  title: string
  body: string
  /** One per batch: a second tab raising the same batch replaces the first. */
  tag: string
  target: AlertTarget
}

/** What a person needs to know about an agent: its name and its team. */
export interface AlertAgent {
  name: string
  teamId: string | null
}

const MAX_TITLE = 80
const quoted = (title: string): string =>
  `"${title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title}"`

const WHAT_HAPPENED: Record<AnnouncedReason, string> = {
  failed: 'failed',
  timed_out: 'stopped responding',
  blocked: 'is blocked',
  needs_review: 'did not pass its checks',
}

/** What an agent waiting on an approval wants to do, in plain words. */
export function approvalAsk(toolName: string): string {
  if (toolName === 'exec' || toolName === 'run_command') return 'run a command'
  if (toolName.startsWith('delegate:')) return 'hand work to another agent'
  const tool = toolName
    .replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
    .replace(/_/g, ' ')
    .trim()
  return `use ${tool || 'a tool'}`
}

function oneLine(item: AlertItem, agentOf: (id: string | null) => AlertAgent | null): string {
  if (item.kind === 'task') return `${quoted(item.title)} ${WHAT_HAPPENED[item.reason]}.`
  const who = agentOf(item.agentId)?.name ?? 'An agent'
  return `${who} wants to ${approvalAsk(item.toolName)}.`
}

/** The team every item belongs to, `all` when they differ, or null when none
 *  names one (an approval nobody can be attributed to shows on every team). */
function sharedTeam(
  items: readonly AlertItem[],
  agentOf: (id: string | null) => AlertAgent | null,
): string | null {
  const teams = new Set<string>()
  for (const i of items) {
    if (i.kind === 'task') {
      if (i.teamId) teams.add(i.teamId)
      continue
    }
    if (!i.agentId) continue
    // An agent outside every team (or one this tab does not know) shows only
    // when the board shows all teams.
    teams.add(agentOf(i.agentId)?.teamId ?? 'all')
  }
  if (teams.size === 0) return null
  return teams.size === 1 ? [...teams][0]! : 'all'
}

/** One alert for one item; a single summary when several arrive at once. */
export function alertNotice(
  fresh: readonly AlertItem[],
  agentOf: (id: string | null) => AlertAgent | null,
): AlertNotice | null {
  if (fresh.length === 0) return null
  const tag = `clawboo-needs-you:${fresh
    .map((i) => i.key)
    .sort()
    .join(',')}`.slice(0, 200)

  if (fresh.length === 1) {
    const item = fresh[0]!
    if (item.kind === 'task') {
      return {
        title: 'A task needs you',
        body: `${oneLine(item, agentOf)} Click to open it.`,
        tag,
        target: { kind: 'task', taskId: item.taskId, teamId: item.teamId },
      }
    }
    const who = agentOf(item.agentId)?.name ?? 'An agent'
    return {
      title: `${who} needs your approval`,
      body: `It wants to ${approvalAsk(item.toolName)}. Click to allow or deny.`,
      tag,
      target: { kind: 'needs-you', teamId: sharedTeam(fresh, agentOf) },
    }
  }

  const approvals = fresh.filter((i) => i.kind === 'approval').length
  const title =
    approvals === 0
      ? `${fresh.length} tasks need you`
      : approvals === fresh.length
        ? `${fresh.length} approvals are waiting`
        : `${fresh.length} things need you`
  // Approvals first, as on the board: they are the ones on a clock.
  const ordered = [...fresh].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === 'approval' ? -1 : 1,
  )
  const shown = ordered.slice(0, 2).map((i) => oneLine(i, agentOf))
  const rest = fresh.length - shown.length
  const more = rest > 0 ? ` And ${rest} more.` : ''
  return {
    title,
    body: `${shown.join(' ')}${more} Click to see them under Needs you.`,
    tag,
    target: { kind: 'needs-you', teamId: sharedTeam(fresh, agentOf) },
  }
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

export interface AlertWatcherDeps {
  /** The board's tasks, or null when the read failed. */
  readTasks(): Promise<readonly AlertTaskInput[] | null>
  /** The pending approvals, or null when the read failed. */
  readApprovals(): Promise<readonly AlertApprovalInput[] | null>
  agentOf(id: string | null): AlertAgent | null
  notify(notice: AlertNotice): void
}

export interface AlertWatcher {
  /** Take what is waiting now as already seen: the person was looking. */
  prime(): Promise<void>
  /** Read again and announce what is new since the last read. */
  check(): Promise<void>
  /** Forget what was seen; the next call primes again. */
  reset(): void
}

/**
 * Reads run one at a time: a call made while one is in flight runs once more
 * after it, so a burst of events costs at most two reads and one alert.
 */
export function createAlertWatcher(deps: AlertWatcherDeps): AlertWatcher {
  // Null until primed. A check before then primes instead: everything already
  // waiting is on the board for the person to see.
  let seen: Set<string> | null = null
  let generation = 0
  let running: Promise<void> | null = null
  let queued: 'prime' | 'check' | null = null

  const read = async (): Promise<AlertItem[] | null> => {
    const [tasks, approvals] = await Promise.all([deps.readTasks(), deps.readApprovals()])
    if (!tasks || !approvals) return null
    return collectAlertItems(tasks, approvals)
  }

  const runOnce = async (mode: 'prime' | 'check'): Promise<void> => {
    const gen = generation
    const items = await read()
    // A reset while the read was out: the answer belongs to a past session.
    if (!items || gen !== generation) return
    if (mode === 'prime' || seen === null) {
      seen = new Set(items.map((i) => i.key))
      return
    }
    const { fresh, seen: next } = diffAlertItems(items, seen)
    seen = next
    const notice = alertNotice(fresh, deps.agentOf)
    if (notice) deps.notify(notice)
  }

  const run = (mode: 'prime' | 'check'): Promise<void> => {
    if (running) {
      // A prime asked for while a check runs still has to happen; a check
      // asked for after a prime is a check.
      queued = queued === 'prime' || mode === 'prime' ? 'prime' : 'check'
      return running
    }
    running = (async () => {
      try {
        let next: 'prime' | 'check' | null = mode
        while (next) {
          queued = null
          try {
            await runOnce(next)
          } catch {
            // The server was briefly out of reach; the next event reads again.
          }
          next = queued
        }
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    prime: () => run('prime'),
    check: () => run('check'),
    reset() {
      generation += 1
      seen = null
      queued = null
    },
  }
}
