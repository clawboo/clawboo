// Which OpenClaw agent owns which browser tab.
//
// THE PROBLEM THIS SOLVES, and why it looks like a detour. clawboo cannot tell
// which OpenClaw agent is calling its MCP server: the Gateway's server URLs carry
// no signed scope, so per-call agentId is undefined and every agent-scoped grant
// is unresolvable. Six routes to close that were investigated and killed. This
// module sidesteps the whole question: OpenClaw 2026.9 stamps the owning session
// onto each tab it opens, durably, in its own words, so the identity is a FACT we
// read rather than an inference we make. That matters more than the cost saving,
// because a wrong attribution here means showing one agent's browsing under
// another agent's name.
//
// THE TAX, stated plainly rather than left in a PR comment. This reads another
// product's private SQLite table. No RPC exposes the session-to-tab mapping; the
// Gateway's whole route surface was enumerated and none returns it. For a
// one-maintainer project that is a recurring cost every time OpenClaw ships.
//
// What makes it survivable is that the vendor gave us its own integrity check.
// Each row's key is a hash of the record's own fields, and OpenClaw itself
// re-derives it as a gate (`if (browserSessionTabStorageKey(record) !== entry.key)
// continue`). We do the same, so a schema change degrades to "cannot show this
// Boo's browsing" instead of to a confident wrong picture. Everything here fails
// closed: a shape we do not recognise is skipped, never guessed at.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveStateDir } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'
import Database from 'better-sqlite3'

const log = createLogger('openclaw-tabs')

/** OpenClaw's plugin-state row for one tracked tab. */
export interface OpenClawTab {
  /** `agent:<sourceAgentId>:<mainKey>` — OpenClaw's own name for the conversation. */
  sessionKey: string
  /** The CDP target id, which is what a screenshot attaches to. */
  targetId: string
  /** Named browser profile the tab lives in. */
  profile: string
  /** When the agent last used it, for picking the newest of several. */
  lastUsedAt: number
}

const TAB_NAMESPACE = 'browser.session-tabs'

/**
 * Recompute a row's storage key from its own contents.
 *
 * COPIED FROM THE VENDOR ON PURPOSE. OpenClaw derives the key as
 * `sha256(JSON.stringify([sessionKey, nativeTargetId, profileFingerprint,
 * browserInstanceFingerprint]))` and uses the recomputation to reject rows it
 * cannot vouch for. Mirroring it is what turns "OpenClaw changed its schema" from
 * a silent mis-attribution into a visible, safe nothing: if the fields we read are
 * not the fields the key was built from, the hash will not match and we skip the
 * row. Verified against the live store, where it reproduces the stored key exactly.
 */
function storageKeyFor(record: Record<string, unknown>): string | null {
  const parts = [
    record['sessionKey'],
    record['nativeTargetId'],
    record['profileFingerprint'],
    record['browserInstanceFingerprint'],
  ]
  if (parts.some((p) => typeof p !== 'string' || p.length === 0)) return null
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}

/** `~/.openclaw/state/openclaw.sqlite`, honouring OPENCLAW_STATE_DIR. */
export function openclawStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), 'state', 'openclaw.sqlite')
}

/**
 * Every tab OpenClaw currently attributes to an agent.
 *
 * Opened READ-ONLY and never written: this is someone else's database, and the
 * Gateway is running against it. Returns an empty list rather than throwing on
 * anything unexpected — a missing file, a renamed table, an unreadable row — so a
 * panel that cannot show browsing degrades to showing nothing.
 */
export function readOpenClawTabs(env: NodeJS.ProcessEnv = process.env): OpenClawTab[] {
  const dbPath = openclawStateDbPath(env)
  if (!fs.existsSync(dbPath)) return []

  let db: Database.Database | null = null
  try {
    // `readonly` is the contract; `fileMustExist` stops better-sqlite3 creating an
    // empty database beside the Gateway's if the path is ever wrong.
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = db
      .prepare(
        `select entry_key as key, value_json as value
           from plugin_state_entries
          where namespace = ?`,
      )
      .all(TAB_NAMESPACE) as { key: string; value: string }[]

    const tabs: OpenClawTab[] = []
    for (const row of rows) {
      let record: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(row.value)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        record = parsed as Record<string, unknown>
      } catch {
        continue
      }
      // The vendor's own gate. A row whose key does not re-derive from its fields
      // is one we no longer understand, and guessing at it is the one failure mode
      // this whole module exists to avoid.
      if (storageKeyFor(record) !== row.key) continue

      const sessionKey = record['sessionKey']
      const targetId = record['nativeTargetId']
      const profile = record['profile']
      if (typeof sessionKey !== 'string' || typeof targetId !== 'string') continue

      tabs.push({
        sessionKey,
        targetId,
        profile: typeof profile === 'string' ? profile : 'openclaw',
        lastUsedAt: typeof record['lastUsedAt'] === 'number' ? record['lastUsedAt'] : 0,
      })
    }
    return tabs
  } catch (err) {
    log.debug({ err }, 'could not read OpenClaw session tabs')
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // Nothing to do; the handle is read-only and the process is short-lived.
    }
  }
}

/**
 * The OpenClaw agent id inside a session key, or null.
 *
 * The key is `agent:<sourceAgentId>:<mainKey>`, and `mainKey` itself may contain
 * colons (`team:<uuid>`, `dashboard:<uuid>`), so this splits off the first two
 * segments only rather than splitting the whole string.
 */
export function sourceAgentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(':')
  if (parts.length < 3 || parts[0] !== 'agent') return null
  const id = parts[1]
  return id && id.length > 0 ? id : null
}

/**
 * The newest tab an OpenClaw agent has open, by its OpenClaw agent id.
 *
 * Newest rather than first because an agent may hold up to eight (OpenClaw's cap),
 * and the one it touched last is the one a "what is this Boo doing" panel means.
 */
export function newestTabForSourceAgent(
  sourceAgentId: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawTab | null {
  let best: OpenClawTab | null = null
  for (const tab of readOpenClawTabs(env)) {
    if (sourceAgentIdFromSessionKey(tab.sessionKey) !== sourceAgentId) continue
    if (!best || tab.lastUsedAt > best.lastUsedAt) best = tab
  }
  return best
}
