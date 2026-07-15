// Native default provider/model resolution — shared by the onboarding seed and
// the native AgentSource. When a native agent is created WITHOUT an explicit
// provider (e.g. CreateTeamModal, which doesn't know which key the user
// connected at onboarding), resolve a WORKING provider from the vault so the
// agent actually runs: an anthropic-defaulted agent created for an OpenAI-only
// user finds no candidate and fails at run time (routeCall's "no provider key
// available"). Explicit-provider callers (the seed) bypass this entirely.

import { envVarForProvider, KNOWN_PROVIDERS } from '@clawboo/adapter-native'

import { resolveRuntimeKey } from '../../secretsVault'

export type ModelTier = 'leader' | 'specialist'

/** Per-provider model picks: a capable model for a leader, a cheap one for a
 *  specialist. These are the current defaults for the paths that DON'T pick a model
 *  (CreateTeamModal without an override, the lazy Boo Zero); the onboarding seed
 *  passes the user's chosen model. A model without a native-pricing entry costs as
 *  estimated (graceful). A custom provider is resolved before we get here. */
export const MODEL_DEFAULTS: Record<string, { leader: string; specialist: string }> = {
  anthropic: { leader: 'claude-sonnet-5', specialist: 'claude-haiku-4-5' },
  openai: { leader: 'gpt-5.4', specialist: 'gpt-4o-mini' },
  openrouter: { leader: 'anthropic/claude-haiku-4.5', specialist: 'openai/gpt-4o-mini' },
  ollama: { leader: 'llama3.2', specialist: 'llama3.2' },
  // The extra OpenAI-compatible providers. Best-guess defaults for the paths that
  // don't pick a model (CreateTeamModal without an override, the lazy Boo Zero) —
  // a native agent that DOES pick a model (onboarding) overrides these.
  google: { leader: 'gemini-2.0-flash', specialist: 'gemini-2.0-flash' },
  xai: { leader: 'grok-2-latest', specialist: 'grok-2-latest' },
  groq: { leader: 'llama-3.3-70b-versatile', specialist: 'llama-3.1-8b-instant' },
  mistral: { leader: 'mistral-large-latest', specialist: 'mistral-small-latest' },
  together: {
    leader: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    specialist: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  cerebras: { leader: 'llama-3.3-70b', specialist: 'llama-3.3-70b' },
  moonshot: { leader: 'moonshot-v1-32k', specialist: 'moonshot-v1-8k' },
}

export interface NativeProviderDefaults {
  primaryProvider: string
  primaryModel: string
  envVar: string
}

/**
 * Resolve `{provider, model, envVar}` from the FIRST connected native key, in
 * KNOWN_PROVIDERS priority (anthropic → openai → openrouter → ollama), mirroring
 * `nativeKeyHealth`'s vault-chain check. A configured `OLLAMA_BASE_URL` is the
 * keyless-Ollama signal. No key at all → the anthropic default (the run surfaces
 * the missing key; createAgent never throws). `envVar` is non-empty by the
 * AgentConfig schema; ollama carries a harmless placeholder (the native router
 * skips key resolution for ollama candidates).
 */
export function resolveConnectedNativeDefaults(tier: ModelTier): NativeProviderDefaults {
  for (const provider of KNOWN_PROVIDERS) {
    if (provider === 'ollama') {
      if (!process.env['OLLAMA_BASE_URL']) continue
      const models = MODEL_DEFAULTS['ollama'] ?? MODEL_DEFAULTS['anthropic']!
      return { primaryProvider: 'ollama', primaryModel: models[tier], envVar: 'OLLAMA_BASE_URL' }
    }
    const envVar = envVarForProvider(provider)
    if (envVar && resolveRuntimeKey(envVar)) {
      const models = MODEL_DEFAULTS[provider] ?? MODEL_DEFAULTS['anthropic']!
      return { primaryProvider: provider, primaryModel: models[tier], envVar }
    }
  }
  const models = MODEL_DEFAULTS['anthropic']!
  return { primaryProvider: 'anthropic', primaryModel: models[tier], envVar: 'ANTHROPIC_API_KEY' }
}

/** True when ANY native provider key resolves (a key in the vault/env, or a
 *  configured Ollama). Used to gate auto-creating a native Boo Zero — without a key
 *  a native agent can't run, so we don't materialize an unrunnable universal leader. */
export function hasConnectedNativeProvider(): boolean {
  for (const provider of KNOWN_PROVIDERS) {
    if (provider === 'ollama') {
      if (process.env['OLLAMA_BASE_URL']) return true
      continue
    }
    const envVar = envVarForProvider(provider)
    if (envVar && resolveRuntimeKey(envVar)) return true
  }
  return false
}
