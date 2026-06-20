// ─── Sessions lineage (session-rotation) ────────────────────────────────────
// The `sessions` table is the dormant seam for the future native runtime. Session
// rotation activates it minimally: when a run rotates (its context window / turn
// budget is exhausted before the task finishes), record a SUCCESSOR session row
// linked to its predecessor via `parentSessionId`, so the rotation chain is queryable in
// SQLite. Runtime-agnostic by construction — the native runtime reuses this exact
// writer. Raw Drizzle stays behind this module (the @clawboo/db convention).

import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { immediateWrite } from '../board/contention'
import type { ClawbooDb } from '../db'
import { sessions, type DbSession } from '../schema'

export interface RecordRotationInput {
  /** The predecessor run's stream key (clawboo's sessionKey). */
  predecessorSessionKey: string
  /** The successor run's stream key. */
  successorSessionKey: string
  agentId?: string | null
  teamId?: string | null
  /** The runtime origin (e.g. 'claude-code') — stored as `sourceId` + `runtime`. */
  runtime?: string | null
  tenantId?: string | null
}

/**
 * Record one rotation: upsert the predecessor session (idempotent on the
 * `(sourceId, sourceSessionId)` unique index) and insert the successor linked to
 * it via `parentSessionId`. One BEGIN IMMEDIATE transaction. Re-running with the
 * same successor key is a no-op (the unique index makes the insert idempotent).
 * Returns both rows for assertion/lineage.
 */
export function recordRotation(
  db: ClawbooDb,
  input: RecordRotationInput,
): { predecessor: DbSession; successor: DbSession } {
  const now = Date.now()
  const sourceId = input.runtime ?? 'openclaw'
  const agentId = input.agentId ?? null
  const teamId = input.teamId ?? null
  const runtime = input.runtime ?? null
  const tenantId = input.tenantId ?? null

  return immediateWrite(db, (tx) => {
    const findBySource = (sourceSessionId: string): DbSession | undefined =>
      tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.sourceId, sourceId), eq(sessions.sourceSessionId, sourceSessionId)))
        .get()

    let predecessor = findBySource(input.predecessorSessionKey)
    if (!predecessor) {
      predecessor = {
        id: randomUUID(),
        sourceId,
        sourceSessionId: input.predecessorSessionKey,
        agentId,
        teamId,
        status: 'closed',
        parentSessionId: null,
        runtime,
        tenantId,
        createdAt: now,
        updatedAt: now,
      }
      tx.insert(sessions).values(predecessor).run()
    }

    let successor = findBySource(input.successorSessionKey)
    if (!successor) {
      successor = {
        id: randomUUID(),
        sourceId,
        sourceSessionId: input.successorSessionKey,
        agentId,
        teamId,
        status: 'active',
        parentSessionId: predecessor.id,
        runtime,
        tenantId,
        createdAt: now,
        updatedAt: now,
      }
      tx.insert(sessions).values(successor).run()
    }

    return { predecessor, successor }
  })
}

/** Look up a session row by its source + stream key (the unique pair). */
export function getSessionBySourceId(
  db: ClawbooDb,
  sourceId: string,
  sourceSessionId: string,
): DbSession | undefined {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.sourceId, sourceId), eq(sessions.sourceSessionId, sourceSessionId)))
    .get()
}

/** Read the rotation chain (newest-first) starting from a session row id. */
export function getSessionLineage(db: ClawbooDb, sessionId: string): DbSession[] {
  const chain: DbSession[] = []
  let cursor: string | null = sessionId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const row: DbSession | undefined = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, cursor))
      .get()
    if (!row) break
    chain.push(row)
    cursor = row.parentSessionId
  }
  return chain
}
