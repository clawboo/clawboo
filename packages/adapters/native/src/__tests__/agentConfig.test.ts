import { describe, expect, it } from 'vitest'

import {
  agentConfigSchema,
  DEFAULT_AGENT_CONFIG,
  envVarForProvider,
  parseAgentConfig,
} from '../agentConfig'

describe('agentConfig', () => {
  it('the default config is schema-valid', () => {
    expect(agentConfigSchema.safeParse(DEFAULT_AGENT_CONFIG).success).toBe(true)
  })

  it('round-trips through JSON', () => {
    const cfg = {
      ...DEFAULT_AGENT_CONFIG,
      id: 'native-lead-abc123',
      name: 'Native Lead',
      fallbacks: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
      budgetUsd: 1.5,
      tenantId: null,
    }
    const parsed = parseAgentConfig(JSON.stringify(cfg))
    expect(parsed).toEqual(cfg)
  })

  it('rejects an invalid blob (and corrupt JSON) by returning null', () => {
    expect(parseAgentConfig(JSON.stringify({ id: '' }))).toBeNull()
    expect(parseAgentConfig('{not json')).toBeNull()
    expect(parseAgentConfig(null)).toBeNull()
  })

  it('keeps participantKind an open set (no enum)', () => {
    const cfg = { ...DEFAULT_AGENT_CONFIG, participantKind: 'human' }
    expect(agentConfigSchema.safeParse(cfg).success).toBe(true)
  })

  it('allows custom OpenAI-compatible provider ids', () => {
    const cfg = { ...DEFAULT_AGENT_CONFIG, primaryProvider: 'my-proxy', envVar: 'MY_PROXY_API_KEY' }
    expect(agentConfigSchema.safeParse(cfg).success).toBe(true)
  })

  it('maps known providers to their conventional env vars (ollama keyless)', () => {
    expect(envVarForProvider('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(envVarForProvider('openai')).toBe('OPENAI_API_KEY')
    expect(envVarForProvider('openrouter')).toBe('OPENROUTER_API_KEY')
    expect(envVarForProvider('ollama')).toBeNull()
    expect(envVarForProvider('unknown-provider')).toBeNull()
  })
})
