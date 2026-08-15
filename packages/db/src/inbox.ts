// agent_inbox accessors — the durable mailbox's tiny surface. See the schema
// comment for the model: rows are agent-bound notifications, delivered by
// whichever channel touches the agent first, surviving eviction and restarts.

import { randomUUID } from 'node:crypto'

import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

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

/** Undelivered rows for an agent, oldest first (optionally team-scoped). */
export function listUndeliveredInbox(
  db: ClawbooDb,
  agentId: string,
  opts?: { teamId?: string | null; limit?: number },
): DbAgentInboxRow[] {
  const conds = [eq(agentInbox.agentId, agentId), isNull(agentInbox.deliveredAt)]
  if (opts?.teamId) conds.push(eq(agentInbox.teamId, opts.teamId))
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

/**
 * Render undelivered rows into a bounded digest block, returning the ids that
 * actually FIT. The delivery guarantee lives here: a caller must mark delivered
 * ONLY `includedIds` — a row truncated out of the render was not delivered, and
 * silently marking it would violate the mailbox's whole promise. Rows are
 * included oldest-first until the budget runs out.
 */
export function renderInboxDigest(
  rows: DbAgentInboxRow[],
  budgetChars = 4_000,
): { text: string | null; includedIds: string[] } {
  if (rows.length === 0) return { text: null, includedIds: [] }
  const header = '[While you were away]'
  const lines: string[] = []
  const includedIds: string[] = []
  let used = header.length
  for (const r of rows) {
    const body =
      r.body.length > DIGEST_ROW_MAX_CHARS ? `${r.body.slice(0, DIGEST_ROW_MAX_CHARS)}…` : r.body
    const line = `- ${body}`
    if (used + line.length + 1 > budgetChars) break
    lines.push(line)
    includedIds.push(r.id)
    used += line.length + 1
  }
  if (lines.length === 0) return { text: null, includedIds: [] }
  return { text: `${header}\n${lines.join('\n')}`, includedIds }
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
