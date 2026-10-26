// Native default provider/model resolution — shared by the onboarding seed and
// the native AgentSource. When a native agent is created WITHOUT an explicit
// provider (e.g. CreateTeamModal, which doesn't know which key the user
// connected at onboarding), resolve a WORKING provider from the vault so the
// agent actually runs: an anthropic-defaulted agent created for an OpenAI-only
// user finds no candidate and fails at run time (routeCall's "no provider key
// available"). Explicit-provider callers (the seed) bypass this entirely.

import { envVarForProvider, KNOWN_PROVIDERS } from '@clawboo/adapter-native'

import {
  getKeylessProviderChoice,
  isRuntimeDisconnected,
  resolveRuntimeKeyForRuntime,
} from '../../secretsVault'
import { listOllamaModels, OLLAMA_FALLBACK_MODEL, pickOllamaModel } from './ollamaModels'

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
  // The static pick; `resolveDeployNativeDefaults` swaps it for a pulled model.
  ollama: { leader: OLLAMA_FALLBACK_MODEL, specialist: OLLAMA_FALLBACK_MODEL },
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

/** True when keyless Ollama is SET UP for the native runtime. The user's recorded
 *  choice decides when there is one: picked (in onboarding or the providers
 *  manager) reads connected with no env var at all, removed reads disconnected
 *  even with one. With no recorded choice, a configured `OLLAMA_BASE_URL` counts,
 *  except after an explicit runtime disconnect, which mutes it the way it mutes an
 *  ambient key. The base URL is `ollamaBaseUrl()`'s either way (the env var, else
 *  the local default). */
export function isNativeOllamaConnected(): boolean {
  const choice = getKeylessProviderChoice('ollama')
  if (choice !== null) return choice
  return Boolean(process.env['OLLAMA_BASE_URL']?.trim()) && !isRuntimeDisconnected('clawboo-native')
}

/**
 * Resolve `{provider, model, envVar}` from the FIRST connected native key, in
 * KNOWN_PROVIDERS priority (anthropic → openai → openrouter → ollama), mirroring
 * `nativeKeyHealth`'s vault-chain check. Keyless Ollama counts once it is set up
 * (`isNativeOllamaConnected`). No key at all → the anthropic default (the run
 * surfaces the missing key; createAgent never throws). `envVar` is non-empty by
 * the AgentConfig schema; ollama carries a harmless placeholder (the native router
 * skips key resolution for ollama candidates).
 */
export function resolveConnectedNativeDefaults(tier: ModelTier): NativeProviderDefaults {
  for (const provider of KNOWN_PROVIDERS) {
    if (provider === 'ollama') {
      if (!isNativeOllamaConnected()) continue
      const models = MODEL_DEFAULTS['ollama'] ?? MODEL_DEFAULTS['anthropic']!
      return { primaryProvider: 'ollama', primaryModel: models[tier], envVar: 'OLLAMA_BASE_URL' }
    }
    const envVar = envVarForProvider(provider)
    if (envVar && resolveRuntimeKeyForRuntime('clawboo-native', envVar)) {
      const models = MODEL_DEFAULTS[provider] ?? MODEL_DEFAULTS['anthropic']!
      return { primaryProvider: provider, primaryModel: models[tier], envVar }
    }
  }
  const models = MODEL_DEFAULTS['anthropic']!
  return { primaryProvider: 'anthropic', primaryModel: models[tier], envVar: 'ANTHROPIC_API_KEY' }
}

/** How long an agent create may reuse a recent `/api/tags` answer: long enough
 *  to cover one team deploy, short enough that a fresh `ollama pull` counts. */
const OLLAMA_DEPLOY_PROBE_MAX_AGE_MS = 10_000

/** `resolveConnectedNativeDefaults` for an agent about to be created. A resolved
 *  Ollama model is checked against what the local daemon has pulled, and one that
 *  isn't there is replaced by a model that is (`pickOllamaModel`), since an
 *  unpulled model fails every run. A pulled pick, an unreachable daemon, and every
 *  other provider pass through unchanged. */
export async function resolveDeployNativeDefaults(
  tier: ModelTier,
): Promise<NativeProviderDefaults> {
  const defaults = resolveConnectedNativeDefaults(tier)
  if (defaults.primaryProvider !== 'ollama') return defaults
  const { models } = await listOllamaModels({ maxAgeMs: OLLAMA_DEPLOY_PROBE_MAX_AGE_MS })
  return { ...defaults, primaryModel: pickOllamaModel(defaults.primaryModel, models) }
}

// Two different questions get asked about a provider, and Ollama is the one place
// they diverge. "Has the user SET UP this provider?" needs an explicit signal, so
// keyless Ollama counts only once the user chose it or configured OLLAMA_BASE_URL
// (`isNativeOllamaConnected`; otherwise every install would look provider-ready and
// auto-mint a native Boo Zero that cannot run). "Can a provider the user ALREADY
// CHOSE actually run?" is the router's question, and there an Ollama candidate
// routes with no key and no env var (ollamaBaseUrl falls back to localhost) unless
// the user removed Ollama (`isNativeOllamaRemoved`). Conflating the two silently
// swaps a deliberate Ollama pick for a paid provider.

/** True when the user removed local Ollama: "Disconnect Ollama", or a full
 *  disconnect of the native runtime. Then nothing runs on it: the router drops its
 *  candidates and existing Ollama agents read not ready, until the user picks
 *  Ollama again. A choice that was simply never made does not count. */
export function isNativeOllamaRemoved(): boolean {
  return getKeylessProviderChoice('ollama') === false
}

/** True when THIS provider is SET UP: a key in the vault/env for its env var, or a
 *  set-up Ollama. Powers `hasConnectedNativeProvider`'s "is anything set up at all"
 *  gate; use `canRunNativeProvider` to judge an existing pick. */
function isNativeProviderConnected(provider: string): boolean {
  if (provider === 'ollama') return isNativeOllamaConnected()
  const envVar = envVarForProvider(provider)
  return Boolean(envVar && resolveRuntimeKeyForRuntime('clawboo-native', envVar))
}

/** True when a provider the user already chose can serve a run, matching the
 *  router's own candidate rule: keyless Ollama routes unless it was removed, every
 *  other provider needs a key in its env var. Use this to validate a STORED choice
 *  (a recorded leader-model pick, a seeded provider); discarding a runnable Ollama
 *  pick here would silently re-point the user at a billed provider. */
export function canRunNativeProvider(provider: string): boolean {
  if (provider === 'ollama') return !isNativeOllamaRemoved()
  const envVar = envVarForProvider(provider)
  return Boolean(envVar && resolveRuntimeKeyForRuntime('clawboo-native', envVar))
}

/** True when THIS agent has at least one runnable candidate, mirroring
 *  `buildCandidates` in routeCall: keyless Ollama routes unless it was removed,
 *  otherwise a key must resolve in the candidate's env var. Fallbacks count, exactly as the
 *  router counts them, so the flag can never contradict what a run would do.
 *  This is the per-agent counterpart of `nativeKeyHealth`, which is deliberately
 *  permissive (ANY connected provider reads healthy): the router keys off THIS
 *  agent's slots, so an agent parked on a disconnected provider fails every run
 *  while the runtime card stays green. Surfaced as `AgentRecord.providerReady`. */
export function nativeAgentProviderReady(config: {
  primaryProvider: string
  envVar: string
  fallbacks?: { provider: string; model: string }[] | undefined
}): boolean {
  const candidates = [
    { provider: config.primaryProvider, envVar: config.envVar },
    ...(config.fallbacks ?? []).map((f) => ({
      provider: f.provider,
      envVar: envVarForProvider(f.provider),
    })),
  ]
  return candidates.some((c) =>
    c.provider === 'ollama'
      ? !isNativeOllamaRemoved()
      : Boolean(c.envVar && resolveRuntimeKeyForRuntime('clawboo-native', c.envVar)),
  )
}

/** True when ANY native provider key resolves (a key in the vault/env, or a set-up
 *  Ollama). Used to gate auto-creating a native Boo Zero: without a key a native
 *  agent can't run, so we don't materialize an unrunnable universal leader. */
export function hasConnectedNativeProvider(): boolean {
  return KNOWN_PROVIDERS.some(isNativeProviderConnected)
}
