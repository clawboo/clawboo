// The stdio Memory bin's provider source applies the dashboard's rules: a
// local-first store never gets a remote provider without the user's choice for
// the current outage, finding Ollama serving withdraws that choice, a store it
// cannot read is treated as local-only, and it re-resolves on a clock.

import {
  createDb,
  DeterministicEmbeddingProvider,
  getSetting,
  LOCAL_FIRST_SETTING,
  REMOTE_EMBEDDING_CONSENT_SETTING,
  setSetting,
  type ClawbooDb,
  type EmbeddingProvider,
  type ResolveEmbeddingOpts,
} from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createStdioEmbedSource } from '../memory/stdioEmbedSource'

let db: ClawbooDb
let saved: string | undefined

beforeEach(() => {
  db = createDb(':memory:')
  saved = process.env['CLAWBOO_DISABLE_EMBEDDINGS']
  delete process.env['CLAWBOO_DISABLE_EMBEDDINGS']
})
afterEach(() => {
  if (saved === undefined) delete process.env['CLAWBOO_DISABLE_EMBEDDINGS']
  else process.env['CLAWBOO_DISABLE_EMBEDDINGS'] = saved
})

function providerWithId(id: string): EmbeddingProvider {
  const inner = new DeterministicEmbeddingProvider()
  return { id, dimensions: inner.dimensions, embed: (t) => inner.embed(t) }
}

function recorder(result: EmbeddingProvider | null) {
  const calls: ResolveEmbeddingOpts[] = []
  return {
    calls,
    resolve: (opts: ResolveEmbeddingOpts) => {
      calls.push(opts)
      return Promise.resolve(result)
    },
  }
}

describe('createStdioEmbedSource', () => {
  it('keeps a local-first store local when no choice of OpenAI stands', async () => {
    setSetting(db, LOCAL_FIRST_SETTING, '1')
    const r = recorder(null)
    await createStdioEmbedSource(db, { resolve: r.resolve })()
    expect(r.calls).toEqual([{ allowRemote: false }])
  })

  it('allows a remote provider for a store that was never indexed locally', async () => {
    const r = recorder(null)
    await createStdioEmbedSource(db, { resolve: r.resolve })()
    expect(r.calls).toEqual([{ allowRemote: true }])
  })

  it('withdraws a choice of OpenAI once it finds Ollama serving', async () => {
    setSetting(db, LOCAL_FIRST_SETTING, '1')
    setSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING, '1')
    const r = recorder(providerWithId('ollama:nomic-embed-text'))
    await createStdioEmbedSource(db, { resolve: r.resolve })()
    expect(r.calls).toEqual([{ allowRemote: true }])
    expect(getSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING)).toBe('0')
  })

  it('treats a store it cannot read as local-only', async () => {
    const r = recorder(null)
    const source = createStdioEmbedSource(db, { resolve: r.resolve })
    db.$client.close()
    await source()
    expect(r.calls).toEqual([{ allowRemote: false }])
  })

  it('re-resolves once the minute is up, not on every call', async () => {
    let t = 0
    const r = recorder(null)
    const source = createStdioEmbedSource(db, { resolve: r.resolve, now: () => t })
    await source()
    t = 59_000
    await source()
    expect(r.calls).toHaveLength(1)
    t = 60_000
    await source()
    expect(r.calls).toHaveLength(2)
  })

  it('resolves nothing while embeddings are turned off', async () => {
    process.env['CLAWBOO_DISABLE_EMBEDDINGS'] = '1'
    const r = recorder(providerWithId('ollama:nomic-embed-text'))
    expect(await createStdioEmbedSource(db, { resolve: r.resolve })()).toBeNull()
    expect(r.calls).toHaveLength(0)
  })
})
