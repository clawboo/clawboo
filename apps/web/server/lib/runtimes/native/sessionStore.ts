// Native session persistence — the runtime's private cognitive plane. The
// conversation transcript (neutral messages) is serialized to
// `<homeDir>/sessions/<sessionId>.json` in the per-identity home the host
// materializes, so a same-runtime resume genuinely continues the conversation.
// A matching `sessions` table row (sourceId 'clawboo-native') is upserted so
// the registry's listSessions has data. No homeDir ⇒ ephemeral (no-ops).

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getSessionBySourceId, sessions, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import type { NeutralMessage } from './providers/types'

const SOURCE_ID = 'clawboo-native'

function sessionPath(homeDir: string, sessionId: string): string | null {
  // The id is harness-minted (`native-<uuid>`), but jail it anyway.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null
  return path.join(homeDir, 'sessions', `${sessionId}.json`)
}

export async function saveSessionTranscript(
  homeDir: string | null,
  sessionId: string,
  messages: NeutralMessage[],
): Promise<void> {
  if (!homeDir) return
  const target = sessionPath(homeDir, sessionId)
  if (!target) return
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify({ version: 1, sessionId, messages }, null, 2), 'utf8')
}

export async function loadSessionTranscript(
  homeDir: string | null,
  sessionId: string,
): Promise<NeutralMessage[] | null> {
  if (!homeDir) return null
  const target = sessionPath(homeDir, sessionId)
  if (!target) return null
  try {
    const raw = await readFile(target, 'utf8')
    const parsed = JSON.parse(raw) as { messages?: unknown }
    return Array.isArray(parsed.messages) ? (parsed.messages as NeutralMessage[]) : null
  } catch {
    // Missing/corrupt transcript ⇒ fresh conversation (the prose handoff in
    // the run context carries continuity) — never a failure.
    return null
  }
}

/** Upsert the registry-visible session row (idempotent on the
 *  (sourceId, sourceSessionId) unique index). Best-effort by contract — a
 *  failed row write must never fail the run. */
export function upsertNativeSessionRow(
  db: ClawbooDb,
  input: { sessionId: string; agentId: string; teamId?: string | null; status?: string },
): void {
  try {
    const now = Date.now()
    const existing = getSessionBySourceId(db, SOURCE_ID, input.sessionId)
    if (existing) {
      db.update(sessions)
        .set({ status: input.status ?? existing.status, updatedAt: now })
        .where(eq(sessions.id, existing.id))
        .run()
      return
    }
    db.insert(sessions)
      .values({
        id: randomUUID(),
        sourceId: SOURCE_ID,
        sourceSessionId: input.sessionId,
        agentId: input.agentId,
        teamId: input.teamId ?? null,
        status: input.status ?? 'active',
        parentSessionId: null,
        runtime: SOURCE_ID,
        tenantId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  } catch {
    // best-effort
  }
}
