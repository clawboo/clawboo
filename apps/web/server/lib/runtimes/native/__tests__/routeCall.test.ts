import { describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '@clawboo/adapter-native'

import { ProviderError, type ProviderClient, type ProviderStreamEvent } from '../providers/types'
import { buildCandidates, createRoutedClient, type RouteCandidate } from '../routeCall'

const CONFIG: AgentConfig = {
  ...DEFAULT_AGENT_CONFIG,
  id: 'native-route-test',
  primaryProvider: 'anthropic',
  primaryModel: 'claude-haiku-4-5',
  envVar: 'ANTHROPIC_API_KEY',
  fallbacks: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
}

function fakeClient(
  provider: string,
  behavior: (call: number) => ProviderStreamEvent[] | ProviderError,
): { client: ProviderClient; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    client: {
      provider,

      async *streamTurn() {
        calls += 1
        const result = behavior(calls)
        if (result instanceof ProviderError) throw result
        for (const ev of result) yield ev
      },
    },
  }
}

const KEYS: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-a', OPENROUTER_API_KEY: 'sk-or' }
const resolveKey = (envVar: string): string | null => KEYS[envVar] ?? null

const TURN = {
  system: 's',
  messages: [],
  tools: [],
  maxOutputTokens: 100,
  signal: new AbortController().signal,
}

async function drain(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe('buildCandidates', () => {
  it('resolves keys per candidate and drops keyless non-ollama candidates', () => {
    const candidates = buildCandidates(CONFIG, undefined, (v) =>
      v === 'ANTHROPIC_API_KEY' ? 'sk-a' : null,
    )
    expect(candidates).toEqual([{ provider: 'anthropic', model: 'claude-haiku-4-5', key: 'sk-a' }])
  })

  it('prefers a per-run apiKeyEnv override over the vault chain', () => {
    const candidates = buildCandidates(CONFIG, { ANTHROPIC_API_KEY: 'run-key' }, () => null)
    expect(candidates[0]).toMatchObject({ key: 'run-key' })
  })

  it('keeps ollama keyless', () => {
    const cfg = { ...CONFIG, fallbacks: [{ provider: 'ollama', model: 'llama3.2' }] }
    const candidates = buildCandidates(cfg, undefined, resolveKey)
    expect(candidates[1]).toEqual({ provider: 'ollama', model: 'llama3.2', key: null })
  })
})

describe('createRoutedClient', () => {
  it('falls back when the primary fails before yielding, then sticks to the winner', async () => {
    const primary = fakeClient('anthropic', () => new ProviderError('401', 'auth', 401))
    const fallback = fakeClient('openrouter', () => [{ type: 'text', delta: 'ok' }])
    const routed = createRoutedClient(CONFIG, undefined, {
      resolveKey,
      makeProvider: (c: RouteCandidate) =>
        c.provider === 'anthropic' ? primary.client : fallback.client,
    })

    expect(await drain(routed.streamTurn(TURN))).toEqual([{ type: 'text', delta: 'ok' }])
    expect(routed.activeProvider()).toBe('openrouter')
    expect(routed.activeModel()).toBe('openai/gpt-4o-mini')

    // Turn 2 goes straight to the sticky winner — the primary is not re-probed.
    await drain(routed.streamTurn(TURN))
    expect(primary.calls()).toBe(1)
    expect(fallback.calls()).toBe(2)
  })

  it('surfaces a mid-stream failure after output instead of retrying (no duplicate text)', async () => {
    const client: ProviderClient = {
      provider: 'anthropic',

      async *streamTurn() {
        yield { type: 'text', delta: 'partial' } as ProviderStreamEvent
        throw new ProviderError('boom', 'overloaded', 529)
      },
    }
    const fallback = fakeClient('openrouter', () => [{ type: 'text', delta: 'never' }])
    const routed = createRoutedClient(CONFIG, undefined, {
      resolveKey,
      makeProvider: (c: RouteCandidate) => (c.provider === 'anthropic' ? client : fallback.client),
    })
    await expect(drain(routed.streamTurn(TURN))).rejects.toMatchObject({ code: 'overloaded' })
    expect(fallback.calls()).toBe(0)
  })

  it('does not fall back on a non-fallback-worthy error', async () => {
    const primary = fakeClient(
      'anthropic',
      () => new ProviderError('bad request', 'bad_request', 400),
    )
    const fallback = fakeClient('openrouter', () => [{ type: 'text', delta: 'never' }])
    const routed = createRoutedClient(CONFIG, undefined, {
      resolveKey,
      makeProvider: (c: RouteCandidate) =>
        c.provider === 'anthropic' ? primary.client : fallback.client,
    })
    await expect(drain(routed.streamTurn(TURN))).rejects.toMatchObject({ code: 'bad_request' })
    expect(fallback.calls()).toBe(0)
  })

  it('throws a typed auth error when no candidate has a key', async () => {
    const routed = createRoutedClient(CONFIG, undefined, {
      resolveKey: () => null,
      makeProvider: () => fakeClient('x', () => []).client,
    })
    await expect(drain(routed.streamTurn(TURN))).rejects.toMatchObject({ code: 'auth' })
  })

  it('setModel overrides the served model (provider stays)', async () => {
    const seen: string[] = []
    const client: ProviderClient = {
      provider: 'anthropic',

      async *streamTurn(p) {
        seen.push(p.model)
        yield { type: 'text', delta: 'x' } as ProviderStreamEvent
      },
    }
    const routed = createRoutedClient(CONFIG, undefined, { resolveKey, makeProvider: () => client })
    await drain(routed.streamTurn(TURN))
    routed.setModel('claude-sonnet-4-6')
    await drain(routed.streamTurn(TURN))
    expect(seen).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6'])
    expect(routed.activeModel()).toBe('claude-sonnet-4-6')
  })
})
