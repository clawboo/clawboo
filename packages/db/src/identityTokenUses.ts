// The ids (`jti`) of the request-bound identity tokens the server accepted, so a
// token is used once even across a restart.
//
// Each identity lane (a sign-in proxy's, the app link's, the reader key's) keeps
// the ids it has seen in memory too, but memory starts empty: before this table,
// a token used once before a restart was accepted once more for the rest of its
// life. A row lives until the token could not be accepted anyway (`until_ms`),
// and the sweep drops the rest. Tokens issued before the server started are not
// refused for that: only a second use is.

import { and, eq, lte, sql } from 'drizzle-orm'

import type { ClawbooDb } from './db'
import { withWriteRetry } from './board/contention'
import { identityTokenUses } from './schema'

export interface IdentityTokenUse {
  /** The lane that accepted it: `proxy`, `app` or `reader`. */
  issuer: string
  jti: string
  /** Epoch ms after which the token could not be accepted anyway. */
  untilMs: number
  /** Epoch ms now: a row that stopped mattering by then no longer counts. */
  nowMs: number
}

/**
 * Record one use of a token. True for its first use; false when the same issuer
 * already recorded the same id and that record still matters (a replay). A
 * record that has stopped mattering is taken over, so an id a sweep has not
 * reached yet does not refuse a new token. One statement, so two requests with
 * the same id cannot both be first. Throws when the row cannot be written.
 */
export function claimIdentityTokenUse(db: ClawbooDb, use: IdentityTokenUse): boolean {
  const result = withWriteRetry(() =>
    db.run(
      sql`INSERT INTO identity_token_uses (issuer, jti, until_ms)
          VALUES (${use.issuer}, ${use.jti}, ${use.untilMs})
          ON CONFLICT (issuer, jti) DO UPDATE SET until_ms = excluded.until_ms
          WHERE identity_token_uses.until_ms <= ${use.nowMs}`,
    ),
  )
  return Number((result as { changes?: number }).changes ?? 0) === 1
}

/** Drop the records that stopped mattering by `nowMs`: every issuer's, or one
 *  issuer's. Returns how many went. */
export function sweepIdentityTokenUses(db: ClawbooDb, nowMs: number, issuer?: string): number {
  const stale = lte(identityTokenUses.untilMs, nowMs)
  const where = issuer === undefined ? stale : and(stale, eq(identityTokenUses.issuer, issuer))
  const result = withWriteRetry(() => db.delete(identityTokenUses).where(where).run())
  return Number((result as { changes?: number }).changes ?? 0)
}
