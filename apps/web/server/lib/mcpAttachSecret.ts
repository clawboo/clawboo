// The per-install MCP attach-signing secret.
//
// One random secret per install, minted lazily and kept in the settings table —
// clawboo's own state, which a spawned runtime's process cannot read (its config
// gets the derived `scopeSig`, never this value). Everything that WRITES an
// attach URL and everything that VERIFIES one goes through here, so both sides
// can never disagree about which secret is in force.

import { randomBytes } from 'node:crypto'

import { getSetting, setSetting, settings, type ClawbooDb } from '@clawboo/db'

const KEY = 'mcp-attach-scope-secret'

let cached: string | null = null

/** Get (or mint, once) the install's attach-signing secret. */
export function getMcpAttachSecret(db: ClawbooDb): string {
  if (cached) return cached
  const existing = getSetting(db, KEY)
  if (existing) {
    cached = existing
    return existing
  }
  // INSERT-OR-IGNORE, then read the stored winner. `setSetting` is an upsert,
  // so two processes initializing against one database would each mint, both
  // "win" their own write, and cache DIFFERENT secrets: every scoped URL signed
  // by one process would fail verification on the other. Conflict-ignore makes
  // the first insert authoritative and everyone else adopts it.
  const minted = randomBytes(32).toString('hex')
  db.insert(settings)
    .values({ key: KEY, value: minted, updatedAt: Date.now() })
    .onConflictDoNothing({ target: settings.key })
    .run()
  const winner = getSetting(db, KEY) ?? minted
  cached = winner
  return winner
}

const rotationListeners = new Set<() => void>()

/**
 * Replace the install's attach-signing secret. Every attach token and scope
 * signature minted under the old one stops verifying at once: copied URLs, the
 * local Gateway's registered URLs and the URLs of runs already in flight. New
 * runs get fresh URLs; a listener (the OpenClaw source) re-registers the Gateway's.
 */
export function rotateMcpAttachSecret(db: ClawbooDb): void {
  const minted = randomBytes(32).toString('hex')
  setSetting(db, KEY, minted)
  cached = minted
  for (const listener of rotationListeners) {
    try {
      listener()
    } catch {
      // A listener's failure must not undo or block the rotation itself.
    }
  }
}

/** Run `listener` after each rotation. Returns the unsubscribe. */
export function onMcpAttachSecretRotated(listener: () => void): () => void {
  rotationListeners.add(listener)
  return () => rotationListeners.delete(listener)
}

/** Test-only: forget the process cache so a fresh db mints/reads its own. */
export function resetMcpAttachSecretCache(): void {
  cached = null
}
