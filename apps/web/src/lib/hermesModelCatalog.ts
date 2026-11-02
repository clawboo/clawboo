// Hermes model catalog: the models the Hermes pickers offer, in team setup
// (CreateTeamModal) and on a Hermes agent's page (the MiniGraph model control).
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

/** The provider stored in a Hermes agent's execConfig `{ provider, model }`, or null. */
export function hermesStoredProvider(execConfig: unknown): string | null {
  if (!execConfig || typeof execConfig !== 'object') return null
  const provider = (execConfig as Record<string, unknown>)['provider']
  return typeof provider === 'string' && provider ? provider : null
}

/** The agent page's note for a Hermes agent on the ChatGPT subscription, in place
 *  of a model switch: the plan's model list is live-only and the page has no live
 *  source for it, so it offers none (never a hard-coded list), and the OpenRouter
 *  list would move the agent off its plan. Null for any other Hermes agent. */
export function hermesPlanModelNote(
  execConfig: unknown,
  model: string | null,
): { pill: string; tip: string } | null {
  if (hermesStoredProvider(execConfig) !== 'openai-codex') return null
  const bare = model?.startsWith(CODEX_PREFIX) ? model.slice(CODEX_PREFIX.length) : model
  return {
    pill: bare ? `${bare} · ChatGPT plan` : 'ChatGPT plan',
    tip: 'This agent runs on your ChatGPT plan. The plan has no model list here, so its model is not changed on this page.',
  }
}

/** What the agent page saves for a picked Hermes model. A pick from a picker group
 *  names its provider (see `hermesModelExec`). A typed custom id names none, so the
 *  server keeps the provider the agent already runs on, unless the id carries the
 *  `openai-codex/` prefix. Null for an empty id. */
export function hermesModelSave(
  id: string,
  fromGroup: boolean,
): { model: string; provider?: string } | null {
  if (!id) return null
  if (fromGroup || id.startsWith(CODEX_PREFIX)) return hermesModelExec(id)
  return { model: id }
}
