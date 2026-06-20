import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { DeterministicEmbeddingProvider } from '../embedding'
import { SqliteMemoryStore } from '../store'
import { buildStructuredSummary } from '../summary'
import type { EmbeddingProvider } from '../types'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

/** A fixed-vector provider with an explicit id — lets a test write two facts under
 *  two distinct embedding "spaces" (same dimension, different model id). */
class FixedEmbed implements EmbeddingProvider {
  readonly dimensions = 4
  constructor(
    readonly id: string,
    private readonly vec: number[],
  ) {}
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(() => this.vec))
  }
}

describe('SqliteMemoryStore — FTS5 round-trip', () => {
  it('saves facts and retrieves them from a fresh store (cross-session recall)', async () => {
    const writer = new SqliteMemoryStore(db) // no embedder → FTS only
    const facts = [
      ['Stripe integration', 'payment processing goes through Stripe checkout'],
      ['Deploy cadence', 'we release on Fridays after the smoke test passes'],
      ['User tone', 'the user prefers concise, direct responses'],
      ['DB engine', 'persistence uses SQLite via better-sqlite3 with WAL'],
      ['Auth', 'device pairing uses Ed25519 keys'],
    ] as const
    for (const [title, content] of facts) await writer.saveFact({ title, content })

    // A "fresh session" = a brand-new store over the SAME db file.
    const reader = new SqliteMemoryStore(db)
    const results = await reader.searchMemory('payment', { mode: 'fts' })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.matchedVia).toBe('fts')
    expect(results[0]?.content).toContain('payment')
  })

  it('FTS query with punctuation does not throw (syntax-safe tokenisation)', async () => {
    const store = new SqliteMemoryStore(db)
    await store.saveFact({ title: 'x', content: 'alpha beta gamma' })
    const results = await store.searchMemory('alpha AND "beta) OR (', { mode: 'fts' })
    expect(Array.isArray(results)).toBe(true)
  })
})

describe('SqliteMemoryStore — vector + hybrid', () => {
  it('vector mode ranks a semantically-related fact first', async () => {
    const store = new SqliteMemoryStore(db, new DeterministicEmbeddingProvider())
    await store.saveFact({ title: 'Stripe', content: 'payment processing via Stripe checkout' })
    await store.saveFact({ title: 'Weather', content: 'the sky outside is clear and blue today' })
    const results = await store.searchMemory('payment processing pipeline', { mode: 'vector' })
    expect(results[0]?.content).toContain('payment')
    expect(results[0]?.matchedVia).toBe('vector')
  })

  it('hybrid blends FTS + vector', async () => {
    const store = new SqliteMemoryStore(db, new DeterministicEmbeddingProvider())
    await store.saveFact({ title: 'Stripe', content: 'payment processing via Stripe checkout' })
    await store.saveFact({ title: 'Other', content: 'unrelated content about gardening tools' })
    const results = await store.searchMemory('payment', { mode: 'hybrid' })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.matchedVia).toBe('hybrid')
    expect(results[0]?.content).toContain('payment')
  })

  it('vector mode without an embedder gracefully falls back to FTS', async () => {
    const store = new SqliteMemoryStore(db) // no embedder
    await store.saveFact({ title: 'P', content: 'payment processing' })
    const results = await store.searchMemory('payment', { mode: 'vector' })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.matchedVia).toBe('fts') // fell back
  })

  it('vector search compares only co-embedded vectors (cross-model is excluded, not cosine-mixed)', async () => {
    const embA = new FixedEmbed('model-a', [1, 0, 0, 0])
    const embB = new FixedEmbed('model-b', [0, 1, 0, 0])
    await new SqliteMemoryStore(db, embA).saveFact({ title: 'A', content: 'model a fact' })
    await new SqliteMemoryStore(db, embB).saveFact({ title: 'B', content: 'model b fact' })

    // Searching under model-b: only the model-b vector is comparable. The model-a
    // row lives in a different embedding space and is EXCLUDED — not cosine-compared
    // at the coincidentally-equal dimension (which would award it a spurious 0.5).
    const results = await new SqliteMemoryStore(db, embB).searchMemory('q', { mode: 'vector' })
    expect(results.map((r) => r.title)).toEqual(['B'])
  })
})

describe('SqliteMemoryStore — scoping', () => {
  it('a team-scoped search sees team + global facts but not another team', async () => {
    const store = new SqliteMemoryStore(db)
    await store.saveFact({
      title: 'TeamA',
      content: 'alpha secret note',
      scope: { teamId: 'team-a' },
    })
    await store.saveFact({ title: 'Global', content: 'alpha global note', scope: {} })
    const inB = await store.searchMemory('alpha', { mode: 'fts', scope: { teamId: 'team-b' } })
    const titles = inB.map((r) => r.title)
    expect(titles).toContain('Global')
    expect(titles).not.toContain('TeamA')
  })

  it('an empty-string teamId scope sees only global facts, never a cross-team wildcard (scope-escape guard)', async () => {
    const store = new SqliteMemoryStore(db)
    await store.saveFact({
      title: 'TeamA',
      content: 'alpha team-a private note',
      scope: { teamId: 'team-a' },
    })
    await store.saveFact({
      title: 'TeamB',
      content: 'alpha team-b private note',
      scope: { teamId: 'team-b' },
    })
    await store.saveFact({ title: 'Global', content: 'alpha global note', scope: {} })

    // '' is PROVIDED (not absent), so it scopes to global-only — it must NOT
    // skip the team filter and leak every team's facts (the falsy-guard bug).
    for (const mode of ['fts', 'vector', 'hybrid'] as const) {
      const titles = (await store.searchMemory('alpha', { mode, scope: { teamId: '' } })).map(
        (r) => r.title,
      )
      expect(titles).toContain('Global')
      expect(titles).not.toContain('TeamA')
      expect(titles).not.toContain('TeamB')
    }
    const browsed = (await store.browseMemory({ scope: { teamId: '' } })).map((f) => f.title)
    expect(browsed).toContain('Global')
    expect(browsed).not.toContain('TeamA')
    expect(browsed).not.toContain('TeamB')

    // Procedures share the same guard.
    await store.saveProcedure({
      name: 'deployA',
      content: 'team-a steps',
      scope: { teamId: 'team-a' },
    })
    await store.saveProcedure({ name: 'deployG', content: 'global steps', scope: {} })
    const procs = (await store.listProcedures({ scope: { teamId: '' } })).map((p) => p.name)
    expect(procs).toContain('deployG')
    expect(procs).not.toContain('deployA')
  })
})

describe('SqliteMemoryStore — procedures', () => {
  it('versions procedures and returns the latest', async () => {
    const store = new SqliteMemoryStore(db)
    await store.saveProcedure({ name: 'deploy', content: 'step one' })
    const p2 = await store.saveProcedure({ name: 'deploy', content: 'step one then two' })
    expect(p2.version).toBe(2)
    const latest = await store.getProcedure('deploy')
    expect(latest?.version).toBe(2)
    expect(latest?.content).toBe('step one then two')
  })

  it('an empty-string and an absent teamId address the SAME (global) procedure', async () => {
    const store = new SqliteMemoryStore(db)
    // Saved with an empty-string team tag…
    await store.saveProcedure({ name: 'deploy', content: 'global steps', scope: { teamId: '' } })
    // …and read back with NO team scope: both normalise to the global (null) row,
    // so the point-lookup is consistent with listProcedures' '' = global handling.
    const got = await store.getProcedure('deploy', { teamId: undefined })
    expect(got?.content).toBe('global steps')
    expect((await store.listProcedures()).some((p) => p.name === 'deploy')).toBe(true)
  })
})

describe('buildStructuredSummary', () => {
  it('renders the fixed template with the expected headings', () => {
    const s = buildStructuredSummary({
      goal: 'Ship the MCP trifecta',
      constraints: ['flag-gated', 'flag-off byte-identical'],
      progress: { done: ['db cores'], inProgress: ['mcp package'], blocked: [] },
      decisions: ['stdio + HTTP transports'],
      filesTouched: ['packages/db/src/memory/store.ts'],
      nextSteps: ['write tests'],
      criticalContext: ['SQLite is the shared substrate'],
    })
    expect(s).toContain('## Goal')
    expect(s).toContain('Ship the MCP trifecta')
    expect(s).toContain('## Constraints')
    expect(s).toContain('### Done')
    expect(s).toContain('### In Progress')
    expect(s).toContain('## Key Decisions')
    expect(s).toContain('## Files Touched')
    expect(s).toContain('## Next Steps')
    expect(s).toContain('## Critical Context')
    // Empty blocked section is omitted.
    expect(s).not.toContain('### Blocked')
  })
})
