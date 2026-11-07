// Browser alerts for what needs a person, raised while the tab is in the background.
//
// Two things are announced: a task an agent's work left waiting on a person (a
// run that failed or stopped responding, a task an agent marked blocked or handed
// back, a question it asked, work that did not pass its checks), and an agent
// waiting for an approval. Reasons a person caused (they pressed Stop, left a task
// without an agent, took a task themselves, or moved the card to Blocked
// themselves) are not announced. A pause is one of those: a person placed it, so a task
// it holds back has no attention at all and shows its pause on the card. Its start is
// in the event log as `pause_placed`.
//
// The desktop app raises the same alerts natively (its needsYou.ts and
// approvals.ts watchers), so the copy and the rules here match it. Everything
// in this file is pure apart from `createAlertWatcher`, which only calls the
// functions it is handed.

import { taskAttentionOf } from '@/features/board/boardStatus'

export const ANNOUNCED_REASONS = [
  'failed',
  'timed_out',
  'blocked',
  'needs_review',
  'question',
  'assigned',
  'agent_wakes',
] as const
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

/** The kinds after which the person's inbox may have changed: what the alerts
 *  wake for, and an approval being answered, which takes one off the badge. A task
 *  that merely changed reaches the inbox through the stream's `activity` event,
 *  because not every write leaves an event row. */
export const INBOX_TRIGGER_KINDS: ReadonlySet<string> = new Set([
  ...ALERT_TRIGGER_KINDS,
  'approval_resolved',
])

/** The newest `seq` among the inbox's trigger events, or 0 when there is none. */
export function latestInboxTrigger(events: ReadonlyArray<{ seq: number; kind: string }>): number {
  let seq = 0
  for (const e of events) if (e.seq > seq && INBOX_TRIGGER_KINDS.has(e.kind)) seq = e.seq
  return seq
}

/** The fields of a board task the alerts read (GET /api/board rows). */
export interface AlertTaskInput {
  id: string
  title?: unknown
  status: string
  teamId?: unknown
  attention?: unknown
  /** The task's last change: for a task that needs a person, when it began to. */
  updatedAt?: unknown
}

/** The fields of a pending approval the alerts read, from either system. */
export interface AlertApprovalInput {
  id: string
  toolName: string
  agentId: string | null
  /** `exec` for a shell command; anything else is a tool call. */
  kind?: string | null
  createdAt?: number | null
  expiresAt?: number | null
}

export type AlertKind = 'task' | 'approval'

export type AlertItem = {
  key: string
  /** When it began waiting on the person, when that is known (epoch ms). */
  at: number | null
} & (
  | {
      kind: 'task'
      taskId: string
      title: string
      reason: AnnouncedReason
      teamId: string | null
    }
  | { kind: 'approval'; approvalId: string; toolName: string; agentId: string | null }
)

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
      at: typeof a.createdAt === 'number' ? a.createdAt : null,
      kind: 'approval',
      approvalId: a.id,
      toolName: a.kind === 'exec' ? 'exec' : a.toolName,
      agentId: a.agentId,
    })
  }
  for (const t of tasks) {
    const attention = taskAttentionOf(t)
    if (!attention || !isAnnounced(attention.reason)) continue
    // The person moved it to Blocked themselves, and no run has started since.
    if (attention.byPerson) continue
    // They took it themselves. An agent handing it back is news.
    if (attention.reason === 'assigned' && !attention.handedBack) continue
    items.push({
      // Keyed by the reason and the failed-run count too: a task that fails,
      // is retried and fails again is news again, even when no read saw it
      // leave the list in between.
      key: `task:${t.id}:${attention.reason}:${attention.failedRuns}`,
      at: typeof t.updatedAt === 'number' ? t.updatedAt : null,
      kind: 'task',
      taskId: t.id,
      title: titleOf(t),
      reason: attention.reason,
      teamId: typeof t.teamId === 'string' && t.teamId ? t.teamId : null,
    })
  }
  return items
}

/** One read of what needs the person. A part that could not be read is not
 *  evidence that its items are gone. */
export interface AlertRead {
  /** The board's tasks, or null when the board could not be read. */
  tasks: readonly AlertTaskInput[] | null
  approvals: readonly AlertApprovalInput[]
  /** False when the approval queue could not be read, so `approvals` holds
   *  only the shell approvals the Gateway socket delivered. */
  approvalsComplete: boolean
}

/** What the watcher remembers while the tab is in the background. */
export interface AlertMemory {
  /** When the tab went to the background. */
  since: number
  /** Items the person already knows about: waiting before the tab left, or
   *  announced since. */
  known: Set<string>
  /** The kinds whose whole list has been read since `since`, so anything new
   *  in them is news whatever its timestamp says. */
  listed: Set<AlertKind>
}

export function startAlertMemory(since: number): AlertMemory {
  return { since, known: new Set(), listed: new Set() }
}

/**
 * Fold one read into memory and return what is news.
 *
 * The read taken as the tab leaves (`announce: false`) only records what is
 * already waiting. An item that began waiting after the tab left is left out
 * of it, so the next read announces it even though it was in that response.
 * Until a kind's whole list has been read, its timestamps decide: an item that
 * began waiting before the tab left was there for the person to see. A part
 * that failed keeps what was known of its kind, and a whole list forgets what
 * has left it, so an item that leaves and comes back is news again.
 */
export function foldAlertRead(
  memory: AlertMemory,
  read: AlertRead,
  opts: { announce: boolean; now?: number },
): { fresh: AlertItem[]; memory: AlertMemory } {
  const now = opts.now ?? Date.now()
  const known = new Set(memory.known)
  const listed = new Set(memory.listed)
  const fresh: AlertItem[] = []
  const began = (i: AlertItem): boolean => i.at !== null && i.at > memory.since

  const parts: { kind: AlertKind; items: AlertItem[]; complete: boolean }[] = [
    {
      kind: 'approval',
      items: collectAlertItems([], read.approvals, now),
      complete: read.approvalsComplete,
    },
  ]
  if (read.tasks) {
    parts.push({ kind: 'task', items: collectAlertItems(read.tasks, [], now), complete: true })
  }

  for (const part of parts) {
    for (const item of part.items) {
      if (known.has(item.key)) continue
      const isNews = listed.has(part.kind) ? true : began(item)
      if (!isNews) {
        known.add(item.key)
        continue
      }
      if (!opts.announce) continue
      fresh.push(item)
      known.add(item.key)
    }
    if (part.complete) {
      const current = new Set(part.items.map((i) => i.key))
      for (const key of [...known]) {
        if (key.startsWith(`${part.kind}:`) && !current.has(key)) known.delete(key)
      }
      listed.add(part.kind)
    }
  }
  return { fresh, memory: { since: memory.since, known, listed } }
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
  question: 'has a question for you',
  assigned: 'was handed back to you',
  agent_wakes: 'needs your OK for agents to wake each other',
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
  /** The pending approvals; `complete` is false when the queue could not be
   *  read and only the locally known ones are listed. */
  readApprovals(): Promise<{ rows: readonly AlertApprovalInput[]; complete: boolean }>
  agentOf(id: string | null): AlertAgent | null
  notify(notice: AlertNotice): void
  /** After each read: false when part of it failed, so the caller can try
   *  again rather than wait for the next event. */
  onRead?(complete: boolean): void
  now?(): number
}

export interface AlertWatcher {
  /** The tab went to the background at `since`: read what is waiting, which
   *  the person has seen, and announce only what begins waiting after it. */
  prime(since: number): Promise<void>
  /** Read again and announce what is new. */
  check(): Promise<void>
  /** Forget everything; the tab is in front again. */
  reset(): void
}

/**
 * Reads run one at a time: a call made while one is in flight runs once more
 * after it, so a burst of events costs at most two reads and one alert.
 */
export function createAlertWatcher(deps: AlertWatcherDeps): AlertWatcher {
  const now = (): number => (deps.now ? deps.now() : Date.now())
  // Null while the tab is in front.
  let memory: AlertMemory | null = null
  let generation = 0
  let running: Promise<void> | null = null
  let queued: 'prime' | 'check' | null = null

  const runOnce = async (mode: 'prime' | 'check'): Promise<void> => {
    const gen = generation
    if (!memory) memory = startAlertMemory(now())
    const [tasks, approvals] = await Promise.all([
      deps.readTasks().catch(() => null),
      deps
        .readApprovals()
        .catch(() => ({ rows: [] as readonly AlertApprovalInput[], complete: false })),
    ])
    // A reset or a new prime while the read was out: it belongs to a past session.
    if (gen !== generation || !memory) return
    const { fresh, memory: next } = foldAlertRead(
      memory,
      { tasks, approvals: approvals.rows, approvalsComplete: approvals.complete },
      { announce: mode === 'check', now: now() },
    )
    memory = next
    const notice = alertNotice(fresh, deps.agentOf)
    if (notice) deps.notify(notice)
    deps.onRead?.(tasks !== null && approvals.complete)
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
            // A notification that could not be shown; the next event reads again.
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
    prime(since) {
      generation += 1
      memory = startAlertMemory(since)
      return run('prime')
    },
    check: () => run('check'),
    reset() {
      generation += 1
      memory = null
      queued = null
    },
  }
}
