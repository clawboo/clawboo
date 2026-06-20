// agentConfigStore (KV round-trip + corrupt fallback), pricing (exact-match
// honesty), and sessionStore (transcript + session-row persistence).

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import { createDb, getSessionBySourceId, setSetting, type ClawbooDb } from '@clawboo/db'

import {
  loadAgentConfig,
  loadAgentConfigOrDefault,
  nativeConfigKey,
  saveAgentConfig,
  readNativeAgentFile,
  writeNativeAgentFile,
} from '../agentConfigStore'
import { priceTurn } from '../pricing'
import {
  loadSessionTranscript,
  saveSessionTranscript,
  upsertNativeSessionRow,
} from '../sessionStore'

describe('native stores', () => {
  let sandbox: string
  let db: ClawbooDb

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-stores-'))
    db = createDb(path.join(sandbox, 'test.db'))
  })
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('agent config round-trips through the settings KV', () => {
    const cfg = { ...DEFAULT_AGENT_CONFIG, id: 'native-a1', name: 'A1', budgetUsd: 2 }
    saveAgentConfig(db, cfg)
    expect(loadAgentConfig(db, 'native-a1')).toEqual(cfg)
  })

  it('a corrupt config blob degrades to the default (per-agent id applied)', () => {
    setSetting(db, nativeConfigKey('native-bad'), '{broken json')
    expect(loadAgentConfig(db, 'native-bad')).toBeNull()
    const fallback = loadAgentConfigOrDefault(db, 'native-bad')
    expect(fallback.id).toBe('native-bad')
    expect(fallback.primaryProvider).toBe(DEFAULT_AGENT_CONFIG.primaryProvider)
  })

  it('agent files round-trip through the settings KV (missing read is empty)', () => {
    expect(readNativeAgentFile(db, 'native-a1', 'SOUL.md')).toBe('')
    writeNativeAgentFile(db, 'native-a1', 'SOUL.md', '# Soul')
    expect(readNativeAgentFile(db, 'native-a1', 'SOUL.md')).toBe('# Soul')
  })

  it('prices pinned models exactly and refuses to guess unknown ones', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(priceTurn('claude-haiku-4-5', usage)).toEqual({ costUsd: 6, estimated: false })
    // Date-suffixed model ids are deterministic aliases of the same price.
    expect(priceTurn('claude-haiku-4-5-20251001', usage)).toEqual({ costUsd: 6, estimated: false })
    expect(priceTurn('gpt-4o-mini', { inputTokens: 1_000_000, outputTokens: 0 })).toEqual({
      costUsd: 0.15,
      estimated: false,
    })
    // OpenRouter ids of the pinned models carry list-price passthrough.
    expect(priceTurn('openai/gpt-4o-mini', usage)).toEqual({ costUsd: 0.75, estimated: false })
    expect(priceTurn('mystery-model', usage)).toEqual({ costUsd: null, estimated: true })
  })

  it('session transcripts persist under <homeDir>/sessions and tolerate misses', async () => {
    const home = path.join(sandbox, 'home')
    await saveSessionTranscript(home, 'native-s1', [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    expect(await loadSessionTranscript(home, 'native-s1')).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    expect(await loadSessionTranscript(home, 'native-missing')).toBeNull()
    expect(await loadSessionTranscript(null, 'native-s1')).toBeNull()
    // A traversal-shaped id is refused outright.
    expect(await loadSessionTranscript(home, '../escape')).toBeNull()
  })

  it('upserts the registry-visible session row idempotently', () => {
    upsertNativeSessionRow(db, { sessionId: 'native-s2', agentId: 'native-a1' })
    upsertNativeSessionRow(db, { sessionId: 'native-s2', agentId: 'native-a1', status: 'closed' })
    const row = getSessionBySourceId(db, 'clawboo-native', 'native-s2')
    expect(row).toMatchObject({
      sourceId: 'clawboo-native',
      agentId: 'native-a1',
      runtime: 'clawboo-native',
      status: 'closed',
      tenantId: null,
    })
  })
})
