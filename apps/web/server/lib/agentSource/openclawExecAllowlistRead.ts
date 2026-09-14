// Read a Boo's standing exec grants WITHOUT changing anything.
//
// THE OBVIOUS WAY IS A WRITE. `exec.approvals.get` is not a read: its handler is
// `respond(true, toExecApprovalsPayload(await ensureExecApprovalsSnapshot()))`
// (openclaw/dist/exec-approvals-C9Z7E1JE.js:104), and `ensureExecApprovalsSnapshot`
// re-serialises the document, writes it back, and mints a socket token when one is
// missing. If the stored row is ever unparseable, that call REPLACES it with a
// fail-closed default and every agent's policy is gone. Opening a permissions panel
// would be enough to do it, before the operator touched a control.
//
// So the list comes from OpenClaw's SQLite row, opened read-only. clawboo already
// does exactly this for the browser tab store (`openclawSessionTabs.ts`), for the
// same reason: this is someone else's database and the Gateway is live against it.
//
// WHAT THIS REFUSES TO DO is as important as what it returns.
//
//   - It NEVER reports "no grants" from a document it could not read. The row
//     carries `agent_count` and `allowlist_count` alongside the JSON, written at
//     save time, so a parse failure with a non-zero count is provably an
//     unreadable document rather than an empty one. An empty list is a safety
//     claim, and this is the one place able to tell the difference.
//   - It NEVER returns `socket.token`. That value is an IPC credential sitting in
//     the same blob; the Gateway redacts it from its own payloads and so does this.
//   - It does not merge the wildcard bucket into the agent's. Enforcement unions
//     `agents['*']` ahead of `agents[id]` (exec-approvals-BSZ-fPIY.js:148), so the
//     wildcard rows are real for this Boo, but they are not this Boo's to revoke.
//     They are returned separately and labelled.

import fs from 'node:fs'

import { classifyExecAllowlistEntry, execAllowlistEntryKey } from '@clawboo/gateway-client'
import type { ExecAllowlistClass } from '@clawboo/gateway-client'
import { createLogger } from '@clawboo/logger'
import Database from 'better-sqlite3'

import { openclawStateDbPath } from '../openclawSessionTabs'

const log = createLogger('exec-allowlist')

export interface ExecAllowlistRow {
  /** Content fingerprint, and the handle a revoke uses. */
  key: string
  pattern: string
  argPattern: string | null
  source: string | null
  classification: ExecAllowlistClass
  /** Which bucket it came from. `'*'` rows apply to every Boo. */
  bucket: 'agent' | 'wildcard'
  /**
   * The last command this row admitted, when OpenClaw recorded one.
   *
   * Never present for an operator-minted grant: `lastUsedCommand` is not written
   * for entries whose argPattern is a generated hash. So a mint can be described
   * by its executable and never by its command, and the UI has to say so rather
   * than leave a blank that reads as "nothing yet".
   */
  lastUsedCommand: string | null
  lastResolvedPath: string | null
  lastUsedAt: number | null
}

export interface ExecAllowlistSnapshot {
  /** The agent's own bucket, which is what a per-Boo revoke may touch. */
  entries: ExecAllowlistRow[]
  /** `agents['*']`, live for this Boo and not revocable from its page. */
  wildcard: ExecAllowlistRow[]
  /**
   * Keys present in BOTH buckets.
   *
   * Revoking one of these from the agent bucket leaves the wildcard copy granting
   * the command, so a post-write check of the agent bucket would report a clean
   * revoke over a permission that still works.
   */
  duplicatedInWildcard: string[]
  /** The Gateway's stored posture for this agent, from the same snapshot. */
  storedSecurity: string | null
  storedAsk: string | null
  /** Document-level defaults, which an absent agent field falls through to. */
  defaultSecurity: string | null
  defaultAsk: string | null
  updatedAtMs: number
}

export type ExecAllowlistReadResult =
  | { state: 'ok'; snapshot: ExecAllowlistSnapshot }
  /** No policy document at all. Genuinely nothing configured, fleet-wide. */
  | { state: 'absent' }
  /** The document exists and could not be read. NEVER render this as empty. */
  | { state: 'unreadable'; reason: string; knownAgentCount: number; knownAllowlistCount: number }

function toRow(raw: unknown, bucket: 'agent' | 'wildcard'): ExecAllowlistRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  const pattern = typeof e['pattern'] === 'string' ? e['pattern'] : ''
  if (!pattern) return null
  const str = (k: string): string | null => (typeof e[k] === 'string' ? (e[k] as string) : null)
  return {
    key: execAllowlistEntryKey(e),
    pattern,
    argPattern: str('argPattern'),
    source: str('source'),
    classification: classifyExecAllowlistEntry(e),
    bucket,
    lastUsedCommand: str('lastUsedCommand'),
    lastResolvedPath: str('lastResolvedPath'),
    lastUsedAt: typeof e['lastUsedAt'] === 'number' ? e['lastUsedAt'] : null,
  }
}

const bucketRows = (doc: Record<string, unknown>, key: string, bucket: 'agent' | 'wildcard') => {
  const agents = doc['agents']
  if (!agents || typeof agents !== 'object') return { rows: [], entry: null }
  const entry = (agents as Record<string, unknown>)[key]
  if (!entry || typeof entry !== 'object') return { rows: [], entry: null }
  const list = (entry as Record<string, unknown>)['allowlist']
  const rows = Array.isArray(list)
    ? list.map((e) => toRow(e, bucket)).filter((r): r is ExecAllowlistRow => r !== null)
    : []
  return { rows, entry: entry as Record<string, unknown> }
}

/**
 * Read one agent's standing grants straight out of OpenClaw's state database.
 *
 * `sourceAgentId` is OPENCLAW'S id, not clawboo's row id. The Gateway keys this
 * document by its own ids, and a lookup under the wrong one returns an empty
 * bucket, which is indistinguishable from a Boo that genuinely has no grants.
 */
export function readOpenClawExecAllowlist(
  sourceAgentId: string,
  env: NodeJS.ProcessEnv = process.env,
): ExecAllowlistReadResult {
  const dbPath = openclawStateDbPath(env)
  if (!fs.existsSync(dbPath)) return { state: 'absent' }

  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db
      .prepare(
        `select raw_json as rawJson,
                default_security as defaultSecurity,
                default_ask as defaultAsk,
                agent_count as agentCount,
                allowlist_count as allowlistCount,
                updated_at_ms as updatedAtMs
           from exec_approvals_config
          where config_key = 'current'`,
      )
      .get() as
      | {
          rawJson: string
          defaultSecurity: string | null
          defaultAsk: string | null
          agentCount: number
          allowlistCount: number
          updatedAtMs: number
        }
      | undefined

    if (!row) return { state: 'absent' }

    let doc: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(row.rawJson)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the stored policy is not an object')
      }
      doc = parsed as Record<string, unknown>
    } catch (err) {
      // THE CASE THIS FUNCTION EXISTS FOR. The counts were written by the last
      // successful save, so they say what the document held before it became
      // unreadable. Reporting an empty list here would tell an operator their Boo
      // has no standing grants while the grants are still on disk and still being
      // enforced, which is the most damaging sentence this screen could print.
      return {
        state: 'unreadable',
        reason: err instanceof Error ? err.message : String(err),
        knownAgentCount: row.agentCount,
        knownAllowlistCount: row.allowlistCount,
      }
    }

    const agent = bucketRows(doc, sourceAgentId, 'agent')
    const wildcard = bucketRows(doc, '*', 'wildcard')
    const wildcardKeys = new Set(wildcard.rows.map((r) => r.key))
    const defaults = (doc['defaults'] ?? {}) as Record<string, unknown>

    const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)

    return {
      state: 'ok',
      snapshot: {
        entries: agent.rows,
        wildcard: wildcard.rows,
        duplicatedInWildcard: agent.rows.filter((r) => wildcardKeys.has(r.key)).map((r) => r.key),
        storedSecurity: asStr(agent.entry?.['security']),
        storedAsk: asStr(agent.entry?.['ask']),
        defaultSecurity: asStr(defaults['security']) ?? row.defaultSecurity,
        defaultAsk: asStr(defaults['ask']) ?? row.defaultAsk,
        updatedAtMs: row.updatedAtMs,
      },
    }
  } catch (err) {
    // A missing table, a locked file, a schema this build does not know. Reported
    // as unreadable rather than empty, for the same reason as the parse failure.
    log.debug({ err }, 'could not read the exec allowlist')
    return {
      state: 'unreadable',
      reason: err instanceof Error ? err.message : String(err),
      knownAgentCount: 0,
      knownAllowlistCount: 0,
    }
  } finally {
    try {
      db?.close()
    } catch {
      // Nothing to do; the handle is read-only and the process is short-lived.
    }
  }
}
