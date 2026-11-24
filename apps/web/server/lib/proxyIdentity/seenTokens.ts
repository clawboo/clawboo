// Where each identity lane records the request-bound tokens it accepted, in the
// server's database (`identity_token_uses`), so a token is used once even across
// a restart. Each verifier keeps its own memory as well (verifier.ts); this is
// what outlives it.
//
// One store per issuer lane (`proxy`, `app`, `reader`), so the same id from two
// issuers never collides. A write that fails is reported and thrown, and the
// verifier then goes by its memory alone, as before; a sweep that fails is only
// reported, since a record past its time gives way to a new token by itself (see
// claimIdentityTokenUse).

import { claimIdentityTokenUse, sweepIdentityTokenUses, type ClawbooDb } from '@clawboo/db'

import { getDb } from '../db'
import type { IdentityIssuer } from './config'
import type { SeenTokenStore } from './verifier'

export interface SeenTokenStoreOptions {
  /** The connection. Defaults to the server's one (`getDb`). */
  db?: () => ClawbooDb
  /** Told when a record cannot be written or swept. Never given the token. */
  onError?: (info: { issuer: IdentityIssuer; op: 'claim' | 'sweep'; err: unknown }) => void
}

export function createSeenTokenStore(
  issuer: IdentityIssuer,
  opts: SeenTokenStoreOptions = {},
): SeenTokenStore {
  const db = opts.db ?? getDb
  return {
    claim(jti, untilMs, nowMs) {
      try {
        return claimIdentityTokenUse(db(), { issuer, jti, untilMs, nowMs })
      } catch (err) {
        opts.onError?.({ issuer, op: 'claim', err })
        throw err
      }
    },
    sweep(nowMs) {
      try {
        sweepIdentityTokenUses(db(), nowMs, issuer)
      } catch (err) {
        opts.onError?.({ issuer, op: 'sweep', err })
      }
    },
  }
}

/** Drop every lane's records that stopped mattering, as the server starts.
 *  Returns how many went. Throws when the database cannot be written. */
export function sweepSeenTokensAtBoot(db: ClawbooDb, nowMs = Date.now()): number {
  return sweepIdentityTokenUses(db, nowMs)
}
