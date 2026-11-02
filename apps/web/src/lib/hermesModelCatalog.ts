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
// It names no model of its own: the plan's models come from the live list
// (`useCodexModels`), and its first entry is the plan default, a pick that pins
// the provider and leaves the model to Hermes, which asks the backend itself.

import type { ModelGroup, ModelOption } from './modelCatalog'

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

/** The subscription pick that names no model: the bare routing prefix. Hermes then
 *  runs the first model the backend lists for the account. */
export const HERMES_CODEX_PLAN_DEFAULT_ID = CODEX_PREFIX

/** The conditional subscription group (offer only when hermes codex auth is present):
 *  the plan default first, then the plan's live models (bare backend ids from
 *  `/api/runtimes/codex/models`) behind the routing prefix. */
export function hermesCodexGroup(liveModels: ModelOption[]): ModelGroup {
  return {
    provider: HERMES_CODEX_GROUP_NAME,
    models: [
      { id: HERMES_CODEX_PLAN_DEFAULT_ID, label: 'Plan default' },
      ...liveModels.map((m) => ({ id: `${CODEX_PREFIX}${m.id}`, label: m.label })),
    ],
  }
}

/** Static fallback groups — a single OpenRouter group. `useHermesModelGroups` swaps in
 *  the LIVE OpenRouter catalog once it loads (and appends the subscription group when
 *  a hermes ChatGPT login is present). */
export const HERMES_MODEL_GROUPS: ModelGroup[] = [
  { provider: HERMES_OPENROUTER_GROUP_NAME, models: HERMES_OPENROUTER_FALLBACK },
]

/** Turn a picked Hermes model id into an execConfig override. Subscription picks carry
 *  the `openai-codex/` routing prefix (stripped: the backend wants the bare id), and
 *  the plan default carries no model at all; every other id is an OpenRouter slug and
 *  pins `--provider openrouter` (the slug rides whole, slashes intact). Returns null
 *  for an empty id (the caller keeps the key-derived default). */
export function hermesModelExec(id: string): { provider: string; model?: string } | null {
  if (!id) return null
  if (id.startsWith(CODEX_PREFIX)) {
    const model = id.slice(CODEX_PREFIX.length)
    return model ? { provider: 'openai-codex', model } : { provider: 'openai-codex' }
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
  if (fromGroup || id.startsWith(CODEX_PREFIX)) {
    const exec = hermesModelExec(id)
    // The plan default names no model, and the model route saves one.
    return exec?.model ? { model: exec.model, provider: exec.provider } : null
  }
  return { model: id }
}
