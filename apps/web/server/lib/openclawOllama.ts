// OpenClaw's own Ollama provider, as clawboo configures it. OpenClaw calls
// Ollama's native API and registers its `ollama` provider only once it has a
// credential: with none, every `ollama/*` run fails as an unknown model, pulled
// or not. A local Ollama accepts any value, and `ollama-local` is the marker
// OpenClaw's own docs use for one. The default model must also be one this
// Ollama has pulled, or the same unknown-model failure comes back on every run.

import {
  OLLAMA_FALLBACK_MODEL,
  listOllamaModels,
  ollamaApiBase,
  ollamaModelPulled,
  ollamaPullCommand,
  pickOllamaModel,
} from './runtimes/native/ollamaModels'

/** The `~/.openclaw/.env` line that registers OpenClaw's local Ollama provider. */
export const OPENCLAW_OLLAMA_KEY_LINE = 'OLLAMA_API_KEY=ollama-local'

// OpenClaw routes on `provider/model` and strips the provider before calling
// Ollama. A bare model id would be read as an OpenAI model.
const OLLAMA_REF_PREFIX = 'ollama/'

/**
 * The `ollama/<model>` ref to make OpenClaw's default: `requested` (with or
 * without its `ollama/` prefix) when Ollama has pulled it, otherwise the pulled
 * model `pickOllamaModel` would give a new native agent. With nothing pulled, or
 * Ollama not answering, the request stands, since no other model could run either.
 */
export async function resolveOpenclawOllamaModel(requested?: string): Promise<string> {
  const trimmed = requested?.trim() ?? ''
  const bare = trimmed.startsWith(OLLAMA_REF_PREFIX)
    ? trimmed.slice(OLLAMA_REF_PREFIX.length)
    : trimmed
  const { models } = await listOllamaModels()
  return `${OLLAMA_REF_PREFIX}${pickOllamaModel(bare || OLLAMA_FALLBACK_MODEL, models)}`
}

/**
 * Whether OpenClaw's default `ref` can run on this Ollama: null for a ref on
 * another provider, else whether Ollama answered with the model pulled (an
 * unreachable Ollama counts as not), plus the command that pulls it when not.
 * Asks Ollama afresh unless `maxAgeMs` allows reusing a recent answer, such as
 * the one `resolveOpenclawOllamaModel` just read.
 */
export async function openclawOllamaModelStatus(
  ref: string,
  opts: { maxAgeMs?: number } = {},
): Promise<{ modelPulled: boolean; pullCommand?: string } | null> {
  if (!ref.startsWith(OLLAMA_REF_PREFIX)) return null
  const model = ref.slice(OLLAMA_REF_PREFIX.length)
  const { models } = await listOllamaModels(opts)
  if (ollamaModelPulled(models, model)) return { modelPulled: true }
  return { modelPulled: false, pullCommand: ollamaPullCommand(model) }
}

/**
 * `models.providers.ollama` for `openclaw.json`, or null to leave OpenClaw on its
 * default `http://127.0.0.1:11434`. OpenClaw never reads `OLLAMA_BASE_URL`, so
 * without this an override would have clawboo pick a model from one Ollama while
 * OpenClaw runs it on another. OpenClaw wants the native root, without `/v1`.
 */
export function openclawOllamaProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string } | null {
  if (!env['OLLAMA_BASE_URL']?.trim()) return null
  return { baseUrl: ollamaApiBase(env) }
}
