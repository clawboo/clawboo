// Scrub-on-write at the store choke point. SqliteMemoryStore is the single
// write path every memory writer (MCP / REST / injection-time defense) funnels
// through, so a credential can never land in a durable, searchable fact —
// regardless of who saves it.

import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { SqliteMemoryStore } from '../store'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

describe('SqliteMemoryStore — scrub on write', () => {
  it('redacts secret-looking values from a fact title + content before persisting', async () => {
    const store = new SqliteMemoryStore(db)
    const secret = 'sk-deadbeef1234567890ABCD'
    const fact = await store.saveFact({
      title: `Deploy key ${secret}`,
      content: `use bearer ${secret} for the prod API; the rest is plain`,
    })
    expect(fact.title).not.toContain(secret)
    expect(fact.content).not.toContain(secret)
    expect(fact.content).toContain('[REDACTED]')
    // Non-secret words survive (it is redaction, not rejection).
    expect(fact.content).toContain('prod API')

    // The persisted + searchable row carries the redacted text, never the secret.
    const results = await store.searchMemory('prod', { mode: 'fts' })
    expect(results.length).toBeGreaterThan(0)
    expect(JSON.stringify(results)).not.toContain(secret)
  })

  it('scrubs procedure content too', async () => {
    const store = new SqliteMemoryStore(db)
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const proc = await store.saveProcedure({ name: 'deploy', content: `run with token ${secret}` })
    expect(proc.content).not.toContain(secret)
    expect(proc.content).toContain('[REDACTED]')
  })

  it('redacts no-prefix credential shapes (PEM / GitLab / Google) before persisting', async () => {
    const store = new SqliteMemoryStore(db)
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----'
    const glpat = `glpat-${'C'.repeat(20)}`
    const google = `AIza${'B'.repeat(35)}`
    const fact = await store.saveFact({ title: 'creds', content: `${pem}\n${glpat}\n${google}` })
    expect(fact.content).not.toContain('BEGIN PRIVATE KEY')
    expect(fact.content).not.toContain(glpat)
    expect(fact.content).not.toContain(google)
    expect(fact.content).toContain('[REDACTED]')
  })
})
