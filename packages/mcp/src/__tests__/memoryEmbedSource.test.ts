// A Memory session that outlives any one embedding provider: given a function
// rather than a provider, every call asks for the current one. So a session an
// agent opened before the model was installed stores vectors once it is, and
// one opened while a provider served stops using it the moment it goes.

import {
  createDb,
  DeterministicEmbeddingProvider,
  type ClawbooDb,
  type EmbeddingProvider,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMemoryServer } from '../memory/server'
import { callText, connectInMemory } from '../testing'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

function modelOf(factId: string): string | null {
  const row = db.$client
    .prepare('SELECT embedding_model AS m FROM memory_facts WHERE id = ?')
    .get(factId) as { m: string | null }
  return row.m
}

async function save(client: Awaited<ReturnType<typeof connectInMemory>>, title: string) {
  const res = await callText(client, 'memory_save', { title, content: `${title} note` })
  return (JSON.parse(res.text) as { fact: { id: string } }).fact.id
}

describe('Memory MCP: an embed source asked on every call', () => {
  it('follows the provider as it comes and goes, within one session', async () => {
    let current: EmbeddingProvider | null = null
    const client = await connectInMemory(createMemoryServer(db, () => current))

    const before = await save(client, 'before')
    current = new DeterministicEmbeddingProvider()
    const during = await save(client, 'during')
    current = null
    const after = await save(client, 'after')

    expect(modelOf(before)).toBeNull()
    expect(modelOf(during)).toBe('deterministic')
    expect(modelOf(after)).toBeNull()
  })

  it('accepts an async source', async () => {
    const provider = new DeterministicEmbeddingProvider()
    const client = await connectInMemory(createMemoryServer(db, async () => provider))
    expect(modelOf(await save(client, 'x'))).toBe('deterministic')
  })

  it('still takes a fixed provider, as the stdio bin did', async () => {
    const client = await connectInMemory(
      createMemoryServer(db, new DeterministicEmbeddingProvider()),
    )
    expect(modelOf(await save(client, 'fixed'))).toBe('deterministic')
  })
})
