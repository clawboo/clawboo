// The per-install MCP attach-signing secret.
//
// One random secret per install, minted lazily and kept in the settings table —
// clawboo's own state, which a spawned runtime's process cannot read (its config
// gets the derived `scopeSig`, never this value). Everything that WRITES an
// attach URL and everything that VERIFIES one goes through here, so both sides
// can never disagree about which secret is in force.

import { randomBytes } from 'node:crypto'

import { getSetting, setSetting, type ClawbooDb } from '@clawboo/db'

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
  const minted = randomBytes(32).toString('hex')
  setSetting(db, KEY, minted)
  cached = minted
  return minted
}

/** Test-only: forget the process cache so a fresh db mints/reads its own. */
export function resetMcpAttachSecretCache(): void {
  cached = null
}
