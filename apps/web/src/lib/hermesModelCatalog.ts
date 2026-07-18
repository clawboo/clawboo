// Hermes model catalog — the models the Hermes per-agent picker (CreateTeamModal)
// offers.
//
// Hermes reaches EVERY model through OpenRouter: the single OpenRouter key (Hermes's
// primary credential + the onboarding default) proxies Anthropic (`anthropic/…`),
// OpenAI (`openai/…`), Google, Meta, DeepSeek, and more. So the picker is a SINGLE
// OpenRouter group and a pick ALWAYS pins `--provider openrouter` — which means it
// always works with the connected key (NO "No <provider> credentials found" from a
// direct-provider pick the user has no separate key for — the bug this replaced), and
// the LIVE OpenRouter catalog gives hundreds of models (see `useHermesModelGroups`).
// The static list below is only the brief fallback before the live catalog loads.
//
// PLUS one conditional group: the ChatGPT subscription (Hermes's native
// `openai-codex` OAuth provider). Its picker ids carry the ROUTING PREFIX
// `openai-codex/` so `hermesModelExec` can discriminate them from OpenRouter
// slugs (which also contain `/` — `openai/gpt-4o-mini` is an OpenRouter vendor
// slug, so a generic first-slash split would misroute it; the specific prefix
// cannot collide because `openai-codex` is not an OpenRouter vendor). The group
// is offered only when a hermes ChatGPT login is detected (`RuntimeStatus.codexAuth`).

import type { ModelGroup } from './modelCatalog'

export const HERMES_OPENROUTER_GROUP_NAME = 'OpenRouter'
export const HERMES_CODEX_GROUP_NAME = 'ChatGPT subscription'

/** The `openai-codex/` routing prefix on subscription picker ids. */
const CODEX_PREFIX = 'openai-codex/'

/** Curated OpenRouter fallback (shown before the live catalog loads / if OpenRouter is
 *  unreachable). All ids are OpenRouter `vendor/model` slugs. */
const HERMES_OPENROUTER_FALLBACK: { id: string; label: string }[] = [
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'openai/gpt-4o', label: 'GPT-4o' },
  { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'google/gemini-flash-1.5', label: 'Gemini Flash 1.5' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
]

/** The ChatGPT-subscription (openai-codex) models — hermes 0.15.2's own codex-backend
 *  defaults. Bare backend ids behind the routing prefix; Spark is a Pro-plan model
 *  (labeled, not hidden — a Plus user picking it gets the provider's own plan error). */
export const HERMES_CODEX_MODELS: { id: string; label: string }[] = [
  { id: 'openai-codex/gpt-5.5', label: 'GPT-5.5' },
  { id: 'openai-codex/gpt-5.4', label: 'GPT-5.4' },
  { id: 'openai-codex/gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'openai-codex/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'openai-codex/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark · Pro plan' },
]

/** The conditional subscription group (offer only when hermes codex auth is present). */
export const HERMES_CODEX_GROUP: ModelGroup = {
  provider: HERMES_CODEX_GROUP_NAME,
  models: HERMES_CODEX_MODELS,
}

/** Static fallback groups — a single OpenRouter group. `useHermesModelGroups` swaps in
 *  the LIVE OpenRouter catalog once it loads (and appends the subscription group when
 *  a hermes ChatGPT login is present). */
export const HERMES_MODEL_GROUPS: ModelGroup[] = [
  { provider: HERMES_OPENROUTER_GROUP_NAME, models: HERMES_OPENROUTER_FALLBACK },
]

/** Turn a picked Hermes model id into an execConfig override. Subscription picks carry
 *  the `openai-codex/` routing prefix (stripped — the backend wants the bare id); every
 *  other id is an OpenRouter slug and pins `--provider openrouter` (the slug rides
 *  whole, slashes intact). Returns null for an empty id (the caller keeps the
 *  key-derived default). */
export function hermesModelExec(id: string): { provider: string; model: string } | null {
  if (!id) return null
  if (id.startsWith(CODEX_PREFIX)) {
    return { provider: 'openai-codex', model: id.slice(CODEX_PREFIX.length) }
  }
  return { provider: 'openrouter', model: id }
}
