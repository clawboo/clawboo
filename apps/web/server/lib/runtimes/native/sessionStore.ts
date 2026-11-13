// Native session persistence — the runtime's private cognitive plane. The
// conversation transcript (neutral messages) is serialized to
// `<homeDir>/sessions/<sessionId>.json` in the per-identity home the host
// materializes, so a same-runtime resume genuinely continues the conversation
// (with agents on their own OS user, at the same place under the data folder:
// see `transcriptHome`). A matching `sessions` table row (sourceId
// 'clawboo-native') is upserted so the registry's listSessions has data. No
// homeDir ⇒ ephemeral (no-ops).

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { getSessionBySourceId, sessions, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { isAgentUserMode } from '../../agentUser/config'
import { runtimeHomesRoot } from '../identityHome'
import type { NeutralMessage } from './providers/types'

const SOURCE_ID = 'clawboo-native'

/**
 * Where a home's transcripts are kept: in the home itself, except with agents
 * on their own OS user (CLAWBOO_AGENT_USER).
 *
 * In that mode the runner hands every runtime a home under the agent user's
 * (`runtimeIdentityHomePath`), which suits a runtime CLI that runs as that user.
 * Nothing of Native runs there: its model loop is this server, and its tools
 * and approved commands work in the run's folder. So its transcripts stay where
 * they always were, under the data folder at the same relative place: out of
 * every agent's reach (a transcript an agent could edit would put words in a
 * resumed conversation), never written or read as the server in agent space,
 * and found again whichever way the setting is. A home that is not a runtime
 * home has no such place, and its run keeps no transcript.
 */
function transcriptHome(homeDir: string): string | null {
  if (!isAgentUserMode()) return homeDir
  const rel = path.relative(runtimeHomesRoot(), path.resolve(homeDir))
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
  return path.join(path.resolve(resolveClawbooDir(), 'runtimes'), rel)
}

function sessionPath(homeDir: string, sessionId: string): string | null {
  // The id is harness-minted (`native-<uuid>`), but jail it anyway.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null
  const home = transcriptHome(homeDir)
  if (!home) return null
  return path.join(home, 'sessions', `${sessionId}.json`)
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
  try {
    const target = sessionPath(homeDir, sessionId)
    if (!target) return null
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
