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

/** Native provider id (lowercase, as stored in AgentConfig.primaryProvider) →
 *  display name + native-format models (strongest first — index 0 is the leader pick). */
const NATIVE_MODELS: Record<string, { label: string; models: { id: string; label: string }[] }> = {
  anthropic: {
    label: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  openai: {
    label: 'OpenAI',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
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
}

/** Turn a catalog model id into a full native execConfig override (provider + model +
 *  vault env-var), or null for an unknown/custom id (the caller keeps modelTier auto-resolve). */
export function nativeModelExec(
  id: string,
): { primaryProvider: string; primaryModel: string; envVar: string } | null {
  const provider = MODEL_TO_PROVIDER[id]
  if (!provider) return null
  return { primaryProvider: provider, primaryModel: id, envVar: PROVIDER_ENV_VAR[provider] ?? 'OLLAMA_BASE_URL' }
}
