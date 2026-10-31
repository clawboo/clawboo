// The per-install MCP attach-signing secret.
//
// One random secret per install, minted lazily and kept in the settings table —
// clawboo's own state, which a spawned runtime's process cannot read (its config
// gets the derived `scopeSig`, never this value). Everything that WRITES an
// attach URL and everything that VERIFIES one goes through here, so both sides
// can never disagree about which secret is in force.
//
// The row is read on every call, never cached in the process: a rotation must
// take effect in every process that shares the database, and a primary-key read
// costs far less than the MCP request it guards.

import { randomBytes } from 'node:crypto'

import { getSetting, setSetting, settings, type ClawbooDb } from '@clawboo/db'

const KEY = 'mcp-attach-scope-secret'

/** Get (or mint, once) the install's attach-signing secret. */
export function getMcpAttachSecret(db: ClawbooDb): string {
  const existing = getSetting(db, KEY)
  if (existing) return existing
  // INSERT-OR-IGNORE, then read the stored winner. `setSetting` is an upsert,
  // so two processes initializing against one database would each mint, both
  // "win" their own write, and sign with DIFFERENT secrets: every scoped URL
  // signed by one process would fail verification on the other. Conflict-ignore
  // makes the first insert authoritative and everyone else adopts it.
  const minted = randomBytes(32).toString('hex')
  db.insert(settings)
    .values({ key: KEY, value: minted, updatedAt: Date.now() })
    .onConflictDoNothing({ target: settings.key })
    .run()
  return getSetting(db, KEY) ?? minted
}

/**
 * What became of the attach URLs a connected OpenClaw Gateway holds:
 * `updated` (it holds the current ones), `retrying` (the write did not land
 * yet; it is retried in the background), or `not-connected` (no Gateway
 * connection; it gets the current URLs when it next connects).
 */
export type GatewayAttachRefresh = 'updated' | 'retrying' | 'not-connected'

let gatewayRefresher: (() => Promise<GatewayAttachRefresh>) | null = null

/** Set (or clear, with null) how a rotation re-registers the Gateway's URLs.
 *  The refresher must never throw. */
export function setGatewayAttachRefresher(
  refresher: (() => Promise<GatewayAttachRefresh>) | null,
): void {
  gatewayRefresher = refresher
}

/**
 * Replace the install's attach-signing secret. Every attach token and scope
 * signature minted under the old one stops verifying at once, in every process
 * on this database: copied URLs, the Gateway's registered URLs and the URLs of
 * runs already in flight. New runs get fresh URLs. Resolves with what became
 * of the Gateway's URLs.
 */
export async function rotateMcpAttachSecret(db: ClawbooDb): Promise<GatewayAttachRefresh> {
  setSetting(db, KEY, randomBytes(32).toString('hex'))
  return gatewayRefresher ? gatewayRefresher() : 'not-connected'
}
