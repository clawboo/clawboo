// agent_inbox accessors — the durable mailbox's tiny surface. See the schema
// comment for the model: rows are agent-bound notifications, delivered by
// whichever channel touches the agent first, surviving eviction and restarts.

import { randomUUID } from 'node:crypto'

import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm'

import type { ClawbooDb } from './db'
import { withWriteRetry } from './board/contention'
import { agentInbox, type DbAgentInboxRow } from './schema'

export type InboxKind = 'task_update' | 'alert' | 'signal'
export type InboxChannel = 'digest' | 'mcp' | 'signal'

export interface EnqueueInboxInput {
  agentId: string
  teamId?: string | null
  kind: InboxKind
  body: string
  taskId?: string | null
}

/** Append a notification to an agent's durable mailbox. */
export function enqueueInbox(db: ClawbooDb, input: EnqueueInboxInput): DbAgentInboxRow {
  const row: DbAgentInboxRow = {
    id: randomUUID(),
    agentId: input.agentId,
    teamId: input.teamId ?? null,
    kind: input.kind,
    body: input.body,
    taskId: input.taskId ?? null,
    createdAt: Date.now(),
    deliveredAt: null,
    deliveredVia: null,
    tenantId: null,
  }
  withWriteRetry(() => db.insert(agentInbox).values(row).run())
  return row
}

/**
 * Undelivered rows for an agent, oldest first (optionally team-scoped).
 *
 * `includeTeamless` widens a team-scoped read to also return rows with no team.
 * A caller that scopes to a team WITHOUT it can never deliver a teamless row, so
 * whichever channel is the last resort for those rows must pass it. Today that is
 * the MCP piggyback: the digest is strictly team-scoped by design (its context
 * block belongs to one team's run), and a teamless row would otherwise sit
 * undelivered forever.
 */
export function listUndeliveredInbox(
  db: ClawbooDb,
  agentId: string,
  opts?: { teamId?: string | null; includeTeamless?: boolean; limit?: number },
): DbAgentInboxRow[] {
  const conds = [eq(agentInbox.agentId, agentId), isNull(agentInbox.deliveredAt)]
  if (opts?.teamId) {
    conds.push(
      opts.includeTeamless
        ? or(eq(agentInbox.teamId, opts.teamId), isNull(agentInbox.teamId))!
        : eq(agentInbox.teamId, opts.teamId),
    )
  }
  return db
    .select()
    .from(agentInbox)
    .where(and(...conds))
    .orderBy(asc(agentInbox.createdAt))
    .limit(opts?.limit ?? 50)
    .all() as DbAgentInboxRow[]
}

/**
 * Mark rows delivered via a channel. Guarded on still-undelivered so two
 * channels racing the same rows record exactly one delivery (first wins) —
 * returns the ids THIS call won, which is what the caller may actually render.
 */
export function markInboxDelivered(db: ClawbooDb, ids: string[], via: InboxChannel): string[] {
  if (ids.length === 0) return []
  const won = withWriteRetry(() =>
    db
      .update(agentInbox)
      .set({ deliveredAt: Date.now(), deliveredVia: via })
      .where(and(inArray(agentInbox.id, ids), isNull(agentInbox.deliveredAt)))
      .returning({ id: agentInbox.id })
      .all(),
  ) as Array<{ id: string }>
  return won.map((r) => r.id)
}

/** Per-row cap inside a digest render (a runaway body can't eat the budget). */
const DIGEST_ROW_MAX_CHARS = 400

/** The mailbox's total context ceiling for one run. Exported so every caller
 *  spends the SAME budget: a per-caller copy is how the bound quietly doubles. */
export const INBOX_BUDGET_CHARS = 4_000

/**
 * Pack rows into a character budget, oldest first, stopping at the first row that
 * does not fit. THE DELIVERY GUARANTEE LIVES HERE: `includedIds` is exactly what
 * was rendered, and a caller must mark delivered only those — a row truncated out
 * of the budget was not delivered, and silently marking it would break the
 * mailbox's whole promise.
 *
 * Separate from `renderInboxDigest` because a caller that renders rows in more
 * than one section (the turn envelope splits them by addressing) has to spend ONE
 * budget across both and union the ids. Re-implementing the loop per section is
 * how the two halves would drift apart and start over-marking.
 */
export function packInboxRows(
  rows: DbAgentInboxRow[],
  budgetChars: number,
): { bodies: string[]; includedIds: string[]; usedChars: number } {
  const bodies: string[] = []
  const includedIds: string[] = []
  let used = 0
  for (const r of rows) {
    const body =
      r.body.length > DIGEST_ROW_MAX_CHARS ? `${r.body.slice(0, DIGEST_ROW_MAX_CHARS)}…` : r.body
    const line = `- ${body}`
    if (used + line.length + 1 > budgetChars) break
    bodies.push(line)
    includedIds.push(r.id)
    used += line.length + 1
  }
  return { bodies, includedIds, usedChars: used }
}

/**
 * Split rows by whether they are DIRECTED at this agent or merely ambient.
 *
 * `kind` has carried this distinction since the mailbox shipped; nothing read it.
 * A `task_update` is a result the agent must synthesize and an `alert` is a
 * coordination failure it has to act on — both are requests. A `signal` is a peer
 * saying something in passing: useful, but it is evidence, not an instruction.
 * Flattening the two into one bullet list is what made "stop, I already fixed
 * that" read as ignorable.
 */
export function splitInboxByAddressing(rows: DbAgentInboxRow[]): {
  addressed: DbAgentInboxRow[]
  ambient: DbAgentInboxRow[]
} {
  const addressed: DbAgentInboxRow[] = []
  const ambient: DbAgentInboxRow[] = []
  for (const r of rows) (r.kind === 'signal' ? ambient : addressed).push(r)
  return { addressed, ambient }
}

/**
 * Render undelivered rows into a bounded digest block, returning the ids that
 * actually FIT. See {@link packInboxRows} for the delivery guarantee. Rows are
 * included oldest-first until the budget runs out.
 */
export function renderInboxDigest(
  rows: DbAgentInboxRow[],
  budgetChars = INBOX_BUDGET_CHARS,
): { text: string | null; includedIds: string[] } {
  if (rows.length === 0) return { text: null, includedIds: [] }
  const header = '[While you were away]'
  const { bodies, includedIds } = packInboxRows(rows, budgetChars - header.length)
  if (bodies.length === 0) return { text: null, includedIds: [] }
  return { text: `${header}\n${bodies.join('\n')}`, includedIds }
}

/** Agents (with their team) holding undelivered mail — the boot-resume scan. */
export function listAgentsWithUndeliveredInbox(
  db: ClawbooDb,
): Array<{ agentId: string; teamId: string | null }> {
  const rows = db
    .selectDistinct({ agentId: agentInbox.agentId, teamId: agentInbox.teamId })
    .from(agentInbox)
    .where(isNull(agentInbox.deliveredAt))
    .all() as Array<{ agentId: string; teamId: string | null }>
  return rows
}
