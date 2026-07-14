// Native model catalog — the model list the native (clawboo-native) pickers show.
//
// DISTINCT from the OpenClaw `MODEL_GROUPS` (lib/modelCatalog.ts): those use the
// OpenClaw ROUTING id shape (`anthropic/claude-haiku-4-5`, `openrouter/anthropic/…`),
// but the native harness passes the model straight to the provider SDK, so it needs
// the PROVIDER-NATIVE id (Anthropic bare `claude-sonnet-4-6`; OpenRouter `vendor/model`
// like `anthropic/claude-haiku-4.5`; OpenAI bare `gpt-4o`). Curated + native-format so a
// pick actually routes; anything not listed is reachable via the selector's "Custom
// model…" input. The ids mirror the native pricing table (native/pricing.ts) + the
// per-provider defaults (nativeProviderDefaults.ts MODEL_DEFAULTS) — the models the
// native runtime already knows/prices — plus the obvious strong sibling per provider.

import type { ModelGroup } from './modelCatalog'
import { NATIVE_MORE_PROVIDERS } from './nativeProviders'

/** Group display names — shared so the dynamic-model hooks can find + replace
 *  exactly these groups with a live list from the provider. */
export const OPENROUTER_GROUP_NAME = 'OpenRouter'
export const ANTHROPIC_GROUP_NAME = 'Anthropic'
export const OPENAI_GROUP_NAME = 'OpenAI'

/** Native provider id (lowercase, as stored in AgentConfig.primaryProvider) →
 *  display name + native-format models (strongest first — index 0 is the leader pick). */
const NATIVE_MODELS: Record<string, { label: string; models: { id: string; label: string }[] }> = {
  // These are the STATIC FALLBACK for Anthropic + OpenAI — shown before a key is
  // stored / while the live list loads. Once a provider key is present, the live
  // list from GET /api/providers/:id/models (useProviderModels) replaces these.
  anthropic: {
    label: ANTHROPIC_GROUP_NAME,
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  openai: {
    label: OPENAI_GROUP_NAME,
    models: [
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    ],
  },
  openrouter: {
    label: OPENROUTER_GROUP_NAME,
    models: [
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
    ],
  },
  ollama: {
    label: 'Ollama',
    models: [{ id: 'llama3.2', label: 'Llama 3.2' }],
  },
  // The extra OpenAI-compatible providers — one recommended model each as the
  // static fallback; the live /models list provides the rest once a key exists.
  ...Object.fromEntries(
    NATIVE_MORE_PROVIDERS.map((p) => [
      p.id as string,
      { label: p.name, models: [{ id: p.recommendedModel, label: p.recommendedLabel }] },
    ]),
  ),
}

/** All native model groups (for the cascading agent-detail selector). */
export const NATIVE_MODEL_GROUPS: ModelGroup[] = Object.values(NATIVE_MODELS).map((g) => ({
  provider: g.label,
  models: g.models,
}))

/** The native model groups for ONE provider (for the onboarding + create-team pickers,
 *  which are scoped to the agent's connected provider). Unknown provider → all groups. */
export function nativeModelGroupsFor(providerId: string): ModelGroup[] {
  const g = NATIVE_MODELS[providerId.toLowerCase()]
  return g ? [{ provider: g.label, models: g.models }] : NATIVE_MODEL_GROUPS
}

/** The recommended (leader-tier) model for a provider — index 0, the strongest curated
 *  pick. Empty string for an unknown provider (the caller falls back to a default). */
export function nativeLeaderModelFor(providerId: string): string {
  return NATIVE_MODELS[providerId.toLowerCase()]?.models[0]?.id ?? ''
}

/** The label for a native model id, or null when it's a custom / unlisted id. */
export function findNativeModelLabel(id: string): string | null {
  for (const g of NATIVE_MODEL_GROUPS) {
    const m = g.models.find((x) => x.id === id)
    if (m) return m.label
  }
  return null
}

// Reverse map (catalog model id → native provider id) + the per-provider vault env-var,
// so a picked model can be turned into a full native execConfig override.
const MODEL_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(NATIVE_MODELS).flatMap(([providerId, g]) =>
    g.models.map((m) => [m.id, providerId] as const),
  ),
)
const PROVIDER_ENV_VAR: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
  ...Object.fromEntries(NATIVE_MORE_PROVIDERS.map((p) => [p.id as string, p.envVar])),
}

/** Turn a catalog model id into a full native execConfig override (provider + model +
 *  vault env-var), or null for an unknown/custom id (the caller keeps modelTier auto-resolve).
 *  A `vendor/model` id not in the curated map is treated as OpenRouter — OpenRouter ids
 *  always contain a "/", unlike the bare Anthropic/OpenAI/Ollama ids — so a dynamically
 *  fetched OpenRouter model still routes correctly. */
export function nativeModelExec(
  id: string,
): { primaryProvider: string; primaryModel: string; envVar: string } | null {
  const provider = MODEL_TO_PROVIDER[id] ?? (id.includes('/') ? 'openrouter' : undefined)
  if (!provider) return null
  return { primaryProvider: provider, primaryModel: id, envVar: PROVIDER_ENV_VAR[provider] ?? 'OLLAMA_BASE_URL' }
}
