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

import type { ModelGroup } from './modelCatalog'

export const HERMES_OPENROUTER_GROUP_NAME = 'OpenRouter'

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

/** Static fallback groups — a single OpenRouter group. `useHermesModelGroups` swaps in
 *  the LIVE OpenRouter catalog once it loads. */
export const HERMES_MODEL_GROUPS: ModelGroup[] = [
  { provider: HERMES_OPENROUTER_GROUP_NAME, models: HERMES_OPENROUTER_FALLBACK },
]

/** Turn a picked OpenRouter model id into a Hermes execConfig override. Hermes runs
 *  every model via OpenRouter, so a pick always pins `--provider openrouter`. Returns
 *  null for an empty id (the caller keeps the key-derived default). */
export function hermesModelExec(id: string): { provider: string; model: string } | null {
  if (!id) return null
  return { provider: 'openrouter', model: id }
}
