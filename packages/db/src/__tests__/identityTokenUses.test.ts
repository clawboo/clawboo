// The record of request-bound identity tokens already used: a second use of one
// id is a replay for as long as the token could be accepted, in the same file
// across connections (a restart), per issuer lane, and a record past its time
// gives way to a new token with the same id.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../db'
import { claimIdentityTokenUse, sweepIdentityTokenUses } from '../identityTokenUses'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const rows = (d: ClawbooDb): Array<{ issuer: string; jti: string; until_ms: number }> =>
  d.all(sql`SELECT issuer, jti, until_ms FROM identity_token_uses ORDER BY issuer, jti`)

describe('claimIdentityTokenUse', () => {
  it('takes the first use of an id and refuses the second while it matters', () => {
    const use = { issuer: 'proxy', jti: 'j-1', untilMs: 2_000, nowMs: 1_000 }
    expect(claimIdentityTokenUse(db, use)).toBe(true)
    expect(claimIdentityTokenUse(db, use)).toBe(false)
    expect(claimIdentityTokenUse(db, { ...use, nowMs: 1_999 })).toBe(false)
    expect(rows(db)).toEqual([{ issuer: 'proxy', jti: 'j-1', until_ms: 2_000 }])
  })

  it('keeps each issuer lane apart', () => {
    for (const issuer of ['proxy', 'app', 'reader']) {
      expect(claimIdentityTokenUse(db, { issuer, jti: 'same', untilMs: 5_000, nowMs: 0 })).toBe(
        true,
      )
    }
    expect(
      claimIdentityTokenUse(db, { issuer: 'reader', jti: 'same', untilMs: 5_000, nowMs: 0 }),
    ).toBe(false)
  })

  it('lets a new token reuse an id whose record stopped mattering, before any sweep', () => {
    expect(claimIdentityTokenUse(db, { issuer: 'app', jti: 'j', untilMs: 1_000, nowMs: 0 })).toBe(
      true,
    )
    expect(
      claimIdentityTokenUse(db, { issuer: 'app', jti: 'j', untilMs: 9_000, nowMs: 1_000 }),
    ).toBe(true)
    expect(rows(db)).toEqual([{ issuer: 'app', jti: 'j', until_ms: 9_000 }])
    expect(
      claimIdentityTokenUse(db, { issuer: 'app', jti: 'j', untilMs: 9_000, nowMs: 1_001 }),
    ).toBe(false)
  })

  it('remembers a use across connections to the same file, as across a restart', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-token-uses-'))
    try {
      const file = path.join(dir, 'clawboo.db')
      const first = createDb(file)
      const use = { issuer: 'reader', jti: 'once', untilMs: Date.now() + 60_000, nowMs: Date.now() }
      expect(claimIdentityTokenUse(first, use)).toBe(true)
      first.$client.close()
      const second = createDb(file)
      expect(claimIdentityTokenUse(second, use)).toBe(false)
      second.$client.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sweepIdentityTokenUses', () => {
  beforeEach(() => {
    claimIdentityTokenUse(db, { issuer: 'proxy', jti: 'old', untilMs: 1_000, nowMs: 0 })
    claimIdentityTokenUse(db, { issuer: 'reader', jti: 'old', untilMs: 1_000, nowMs: 0 })
    claimIdentityTokenUse(db, { issuer: 'proxy', jti: 'live', untilMs: 5_000, nowMs: 0 })
  })

  it("drops one issuer's records that stopped mattering", () => {
    expect(sweepIdentityTokenUses(db, 1_000, 'proxy')).toBe(1)
    expect(rows(db).map((r) => `${r.issuer}/${r.jti}`)).toEqual(['proxy/live', 'reader/old'])
  })

  it("drops every issuer's, and nothing that still matters", () => {
    expect(sweepIdentityTokenUses(db, 4_999)).toBe(2)
    expect(rows(db).map((r) => `${r.issuer}/${r.jti}`)).toEqual(['proxy/live'])
  })
})
