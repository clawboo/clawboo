// The self-documenting `[Task Update]` envelope: the chat-fused board's
// round-trip, reflecting terminated BOARD tasks back to the leader (the single
// reduce point) so it synthesizes OR reacts to a failure. Pure string building;
// the engine and any host that renders the leader's reduce input share it.

/**
 * Terminal outcome of a board task, as reflected back to the leader. `'done'`
 * (or omitted) is a successful completion; the others are failures the leader
 * must act on rather than keep waiting for.
 */
export type TaskUpdateOutcome = 'done' | 'error' | 'aborted' | 'timeout' | 'max_turns'

export interface TaskUpdateItem {
  /** Resolved assignee name (agent or, later, a human). */
  by: string
  /** Task title, for context. */
  title?: string
  /** Condensed report-up (success) or the failure reason/detail. */
  summary: string
  /** Terminal outcome. Omitted / `'done'` renders as a successful ✓ entry. */
  outcome?: TaskUpdateOutcome
}

const TASK_FAILURE_LABEL: Record<Exclude<TaskUpdateOutcome, 'done'>, string> = {
  error: 'failed with an error',
  aborted: 'was stopped before finishing',
  timeout: 'went silent — timed out with no response',
  max_turns: 'ran out of room before finishing',
}

function isTaskFailure(outcome?: TaskUpdateOutcome): outcome is Exclude<TaskUpdateOutcome, 'done'> {
  return outcome != null && outcome !== 'done'
}

/** The human label for a failed outcome, or null when the task succeeded. */
function taskFailureLabel(outcome?: TaskUpdateOutcome): string | null {
  return isTaskFailure(outcome) ? TASK_FAILURE_LABEL[outcome] : null
}

/**
 * Build a `[Task Update]` envelope reflecting terminated BOARD tasks back to the
 * leader so it can synthesize OR react to a failure (the chat-fused board's
 * round-trip). The summaries come from durable task rows (the report-up comment /
 * execution summary / failure reason), not chat scrollback. Deliberately
 * participant-kind-agnostic — it says "a task finished/failed", never "your
 * teammate agent", so a human-completed task reflects identically.
 *
 * A FAILED entry (`outcome` other than `'done'`) is the fix for the
 * "delegating agent left standing" bug: the leader is told a delegate failed or
 * went silent — with the reason — and instructed to decide what to do next
 * instead of waiting forever (the anti-blind-retry framing from the
 * observability literature).
 */
/** Delegations this recipient is STILL waiting on, for the header line. */
export interface OutstandingDelegation {
  /** Assignee name, so the reader knows who to chase. */
  by: string
  /** Task title, truncated by the caller if long. */
  title?: string
}

/** How the envelope is framed for its recipient. */
export interface TaskUpdateOptions {
  /** Set when the recipient delegated these tasks while on a task that has since
   *  closed: its reply is a follow-up on that task, not a message to the user.
   *  `title` is that task's title, when known. */
  followUp?: { title?: string }
}

/** Shorten a title exactly as the item headers below do. */
const clipTitle = (title: string): string =>
  title.length > 80 ? title.slice(0, 80) + '...' : title

/**
 * `outstanding` is the cardinality half of reply-threads, and deliberately only
 * that. A delegator batching three answers has no way today to tell "all three
 * are in" from "one is in and two are still running", so it either waits on work
 * that already finished or synthesizes a partial answer as if it were complete.
 * One header line fixes that without a thread id, a new verb, or a column: the
 * information is already on the board, it was just never rendered.
 *
 * Omitted or empty renders NOTHING, so an existing call is byte-identical. The
 * same holds for `opts`: only `followUp` changes the second header line.
 */
export function buildTaskUpdateMessage(
  items: TaskUpdateItem[],
  outstanding: OutstandingDelegation[] = [],
  opts: TaskUpdateOptions = {},
): string {
  if (items.length === 0) return ''
  const failures = items.filter((i) => isTaskFailure(i.outcome))
  const plural = items.length === 1 ? 'task' : 'tasks'
  const where = opts.followUp?.title ? `"${clipTitle(opts.followUp.title)}"` : 'a task'
  const headerLines = [
    `[Task Update] — ${items.length} ${plural} on the board reached a terminal state (not a fresh user message).`,
    opts.followUp
      ? `These came back from work you handed to teammates while on ${where}, which has since closed. Your reply is not shown to the user: it is recorded on that task and passed to whoever gave it to you. Reply with ONE short, concrete follow-up on what these results add to it. Do not address the user or ask them anything, and do NOT acknowledge the results individually.`
      : 'These are board-sourced results. Synthesize across them ONLY when the user is waiting on a combined answer, or when you need a unified takeaway to drive the next step. Do NOT acknowledge them individually.',
  ]
  if (outstanding.length > 0) {
    const named = outstanding
      .slice(0, 3)
      .map((o) => (o.title ? `${o.by} ("${o.title}")` : o.by))
      .join(', ')
    const more = outstanding.length > 3 ? `, and ${outstanding.length - 3} more` : ''
    headerLines.push(
      `Still outstanding: ${outstanding.length} — ${named}${more}. These have NOT reported yet, so do not treat the results below as the complete picture.`,
    )
  }
  if (failures.length > 0) {
    headerLines.push(
      `⚠ ${failures.length} of these did NOT complete (the ⚠ entries below). Decide what to do next — retry, reassign to another teammate, or tell the user it failed and why. Do NOT keep silently waiting on them.`,
    )
  }
  const sections = [headerLines.join('\n'), '---']
  for (const item of items) {
    const failLabel = taskFailureLabel(item.outcome)
    const failed = failLabel != null
    let header = failed ? `⚠ ${item.by} — DID NOT COMPLETE (${failLabel})` : `✓ ${item.by}`
    if (item.title) {
      const ctx = item.title.length > 80 ? item.title.slice(0, 80) + '...' : item.title
      header += ` — "${ctx}"`
    }
    sections.push(header)
    sections.push(item.summary || (failed ? '(no output was produced before it stopped)' : ''))
    sections.push('---')
  }
  return sections.join('\n')
}
