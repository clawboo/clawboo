// The database record behind each lane's single-use check: one store per lane,
// a failed write reported and thrown (the verifier then refuses the token), a
// failed sweep reported and swallowed, and the boot sweep across every lane.

import { claimIdentityTokenUse, createDb, type ClawbooDb } from '@clawboo/db'
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { createSeenTokenStore, sweepSeenTokensAtBoot } from '../seenTokens'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const left = (): string[] =>
  db
    .all<{ issuer: string; jti: string }>(sql`SELECT issuer, jti FROM identity_token_uses`)
    .map((r) => `${r.issuer}/${r.jti}`)
    .sort()

describe('createSeenTokenStore', () => {
  it('records each lane apart, and refuses a second use on the same lane', () => {
    const proxy = createSeenTokenStore('proxy', { db: () => db })
    const reader = createSeenTokenStore('reader', { db: () => db })
    expect(proxy.claim('j', 5_000, 0)).toBe(true)
    expect(reader.claim('j', 5_000, 0)).toBe(true)
    expect(proxy.claim('j', 5_000, 1)).toBe(false)
    expect(left()).toEqual(['proxy/j', 'reader/j'])
  })

  it('sweeps only its own lane', () => {
    const proxy = createSeenTokenStore('proxy', { db: () => db })
    claimIdentityTokenUse(db, { issuer: 'proxy', jti: 'p', untilMs: 10, nowMs: 0 })
    claimIdentityTokenUse(db, { issuer: 'app', jti: 'a', untilMs: 10, nowMs: 0 })
    proxy.sweep(10)
    expect(left()).toEqual(['app/a'])
  })

  it('reports and throws a write it cannot make, and reports a sweep it cannot make', () => {
    const errors: string[] = []
    const store = createSeenTokenStore('app', {
      db: () => {
        throw new Error('database is locked')
      },
      onError: ({ issuer, op }) => errors.push(`${issuer}:${op}`),
    })
    expect(() => store.claim('j', 5_000, 0)).toThrow(/locked/)
    expect(() => store.sweep(0)).not.toThrow()
    expect(errors).toEqual(['app:claim', 'app:sweep'])
  })
})

describe('sweepSeenTokensAtBoot', () => {
  it("drops every lane's records past their time, and keeps the rest", () => {
    for (const issuer of ['proxy', 'app', 'reader']) {
      claimIdentityTokenUse(db, { issuer, jti: 'old', untilMs: 1_000, nowMs: 0 })
    }
    claimIdentityTokenUse(db, { issuer: 'reader', jti: 'live', untilMs: 9_000, nowMs: 0 })
    expect(sweepSeenTokensAtBoot(db, 1_000)).toBe(3)
    expect(left()).toEqual(['reader/live'])
  })
})
