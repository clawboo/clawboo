import { describe, expect, it } from 'vitest'

import {
  agentConfigSchema,
  COORDINATION_TOOLSET,
  DEFAULT_AGENT_CONFIG,
  envVarForProvider,
  isFrozenTeamToolset,
  KNOWN_PROVIDERS,
  NATIVE_PROVIDER_ENV_VARS,
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

  it("accepts tasks:'read' as a toolset mode", () => {
    const cfg = {
      ...DEFAULT_AGENT_CONFIG,
      tools: { memory: true, tools: true, tasks: 'read', teamchat: true },
    }
    const result = agentConfigSchema.safeParse(cfg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.tools.tasks).toBe('read')
  })

  it('never coerces a stored toolset on load (the repair is a one-shot, not a load-time override)', () => {
    const frozen = {
      ...DEFAULT_AGENT_CONFIG,
      tools: { memory: true, tools: true, tasks: false, teamchat: false },
    }
    const parsed = parseAgentConfig(JSON.stringify(frozen))
    expect(parsed?.tools).toEqual(frozen.tools)
  })

  it('recognizes the frozen signature on the COORDINATION axes only', () => {
    // memory / tools are orthogonal and user-toggleable, so they must not gate
    // the repair — an owner who once disabled the memory MCP still gets fixed.
    const frozen = [
      { memory: true, tools: true, tasks: false, teamchat: false },
      { memory: false, tools: true, tasks: false, teamchat: false },
      { memory: true, tools: false, tasks: false, teamchat: false },
      { memory: true, tools: true, tasks: false, teamchat: false, custom: ['svc'] },
    ]
    for (const tools of frozen) expect(isFrozenTeamToolset(tools)).toBe(true)
  })

  it('leaves any toolset with a live coordination axis alone', () => {
    const deliberate = [
      { memory: true, tools: true, tasks: true, teamchat: false },
      { memory: true, tools: true, tasks: false, teamchat: true },
      { memory: true, tools: true, tasks: 'read' as const, teamchat: true },
    ]
    for (const tools of deliberate) expect(isFrozenTeamToolset(tools)).toBe(false)
  })

  it('COORDINATION_TOOLSET is the schema-valid repair target', () => {
    const cfg = { ...DEFAULT_AGENT_CONFIG, tools: { ...COORDINATION_TOOLSET } }
    expect(agentConfigSchema.safeParse(cfg).success).toBe(true)
    expect(COORDINATION_TOOLSET.tasks).toBe('read')
    expect(COORDINATION_TOOLSET.teamchat).toBe(true)
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

  it('maps the extra OpenAI-compatible providers to their env vars', () => {
    expect(envVarForProvider('google')).toBe('GEMINI_API_KEY')
    expect(envVarForProvider('xai')).toBe('XAI_API_KEY')
    expect(envVarForProvider('groq')).toBe('GROQ_API_KEY')
    expect(envVarForProvider('mistral')).toBe('MISTRAL_API_KEY')
    expect(envVarForProvider('together')).toBe('TOGETHER_API_KEY')
    expect(envVarForProvider('cerebras')).toBe('CEREBRAS_API_KEY')
    expect(envVarForProvider('moonshot')).toBe('MOONSHOT_API_KEY')
  })

  it('NATIVE_PROVIDER_ENV_VARS covers every keyed known provider', () => {
    const keyed = KNOWN_PROVIDERS.filter((p) => p !== 'ollama')
    for (const p of keyed) {
      const ev = envVarForProvider(p)
      expect(ev).not.toBeNull()
      expect(NATIVE_PROVIDER_ENV_VARS).toContain(ev)
    }
  })
})
