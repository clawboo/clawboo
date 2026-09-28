// ─── modelProvider ───────────────────────────────────────────────────────────
//
// Resolve an agent's current MODEL string into (a) a provider BRAND that
// ProviderIcon can render, and (b) a human display LABEL — for the model
// orbital node in the Ghost Graph.
//
// The model-id format varies by runtime:
//   - native   : provider-native ids, bare (`claude-sonnet-5`, `gpt-4o`,
//                `gemini-2.0-flash`, `llama3.2`) or OpenRouter `vendor/model`
//                (`anthropic/claude-haiku-4.5`).
//   - openclaw : OpenClaw routing ids `provider/model`
//                (`anthropic/claude-haiku-4-5`), or double-nested OpenRouter
//                `openrouter/vendor/model` (`openrouter/x-ai/grok-3`).
//   - hermes   : always routed through OpenRouter; an OpenRouter `vendor/model`.
//   - codex / claude-code : model is null (account/SDK default).
//
// Strategy: prefer the MODEL-MAKER's brand (so the icon agrees with the label —
// `openrouter/anthropic/claude-opus` shows the Anthropic mark, not OpenRouter),
// falling back to the OpenRouter mark for OpenRouter-routed models whose vendor
// isn't a known brand, and to no-provider (a generic glyph) for anything else.

import { PROVIDER_BRAND, type ProviderId } from '@/features/onboarding/ProviderIcon'

import { findModelLabel, findProviderForModel } from './modelCatalog'
import { findNativeModelLabel, nativeModelExec } from './nativeModelCatalog'

export interface ResolvedModelProvider {
  /** A ProviderId ProviderIcon can render, or null when no brand is known. */
  providerId: ProviderId | null
  /** Human display label for the model (e.g. "Claude Sonnet 4.6"). */
  label: string
}

const PROVIDER_IDS = new Set<string>(Object.keys(PROVIDER_BRAND))

// Assorted provider spellings (vendor prefixes, catalog TitleCase names) →
// canonical ProviderId. Only entries that DON'T reduce to a ProviderId via the
// slug fallback below need listing here.
const PROVIDER_ALIAS: Record<string, ProviderId> = {
  'x-ai': 'xai',
  mistralai: 'mistral',
  moonshotai: 'moonshot',
  'ollama (local)': 'ollama',
  ollamalocal: 'ollama',
  gemini: 'google',
  googlegemini: 'google',
}

/** Normalize any provider spelling (vendor prefix, catalog name) → ProviderId. */
export function normalizeProviderId(raw: string | null | undefined): ProviderId | null {
  if (!raw) return null
  const s = String(raw).trim().toLowerCase()
  if (PROVIDER_IDS.has(s)) return s as ProviderId
  if (PROVIDER_ALIAS[s]) return PROVIDER_ALIAS[s]
  // Slug fallback: "Hugging Face" → huggingface, "xAI" → xai, "OpenRouter" → openrouter.
  const slug = s.replace(/[^a-z0-9]/g, '')
  if (PROVIDER_IDS.has(slug)) return slug as ProviderId
  if (PROVIDER_ALIAS[slug]) return PROVIDER_ALIAS[slug]
  return null
}

/** Last resort: infer the maker from keywords in a bare/custom model id. */
function providerFromKeyword(model: string): ProviderId | null {
  const m = model.toLowerCase()
  if (m.includes('claude')) return 'anthropic'
  if (m.includes('gemini') || m.includes('palm')) return 'google'
  if (m.includes('mixtral') || m.includes('mistral')) return 'mistral'
  if (m.includes('grok')) return 'xai'
  if (m.includes('gpt') || m.includes('chatgpt') || /(^|[^a-z])o[1-9](-|$)/.test(m)) return 'openai'
  return null
}

/** Best-effort ProviderId from a model id (vendor prefix → catalog → keyword). */
function providerFromModelId(model: string): ProviderId | null {
  const segs = model.split('/').filter(Boolean)
  // Strip a leading `openrouter` router segment — the real vendor is next.
  const parts = segs[0]?.toLowerCase() === 'openrouter' ? segs.slice(1) : segs
  for (const seg of parts) {
    const id = normalizeProviderId(seg)
    if (id) return id
  }
  const fromCatalog = normalizeProviderId(findProviderForModel(model))
  if (fromCatalog) return fromCatalog
  return providerFromKeyword(model)
}

// Words a model id spells in lowercase that the maker writes differently. Only
// what plain title case gets wrong belongs here: "claude", "gemini" and "llama"
// come out right on their own.
const MODEL_WORD: Record<string, string> = {
  gpt: 'GPT',
  glm: 'GLM',
  qwq: 'QwQ',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  openai: 'OpenAI',
  xai: 'xAI',
}

function modelWord(word: string): string {
  // Capitals mean someone already chose this spelling ("MiniMax-M2.5").
  if (/[A-Z]/.test(word)) return word
  if (MODEL_WORD[word]) return MODEL_WORD[word]
  // OpenAI writes its reasoning series in lowercase: o1, o3, o4.
  if (/^o\d/.test(word)) return word
  // One letter then a version names a generation: m2.7, r1, k2.
  if (/^[a-z]\d+(\.\d+)*$/.test(word)) return word.toUpperCase()
  // A size or a context length: 70b, 8b, 128k.
  if (/^\d+(\.\d+)?[bkmt]$/.test(word)) return word.toUpperCase()
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * A readable name for a model id that no catalog lists.
 *
 * The id used to be shown as-is, so the model tile under a Boo on a model
 * clawboo had not catalogued read "minimax-m2.7" beside tiles reading "Claude
 * Sonnet 4.6". Only the name on the tile changes: the orbital's tooltip keeps
 * the exact id, because that is what a person pastes into a config.
 */
export function prettifyModelId(model: string): string {
  const tail = model.split('/').filter(Boolean).pop() ?? model
  const tokens = tail.split(/[-_]+/).filter(Boolean)
  // A trailing date names a snapshot rather than the model a person picked.
  if (tokens.length > 1 && /^\d{8}$/.test(tokens[tokens.length - 1]!)) tokens.pop()
  if (
    tokens.length > 3 &&
    /^\d{4}$/.test(tokens[tokens.length - 3]!) &&
    /^\d{2}$/.test(tokens[tokens.length - 2]!) &&
    /^\d{2}$/.test(tokens[tokens.length - 1]!)
  ) {
    tokens.splice(-3)
  }
  // Ids spell a version as separate numbers: claude-sonnet-4-5 is Sonnet 4.5.
  // Only short numbers join, so a snapshot like gpt-4-1106 does not become 4.1106.
  const words: string[] = []
  for (const token of tokens) {
    const prev = words[words.length - 1]
    if (prev !== undefined && /^\d{1,2}(\.\d{1,2})*$/.test(prev) && /^\d{1,2}$/.test(token)) {
      words[words.length - 1] = `${prev}.${token}`
    } else {
      words.push(token)
    }
  }
  return words.length > 0 ? words.map(modelWord).join(' ') : model
}

/**
 * Resolve a model + runtime into a provider brand + display label for the model
 * orbital node. A null/empty model (codex / claude-code account default) returns
 * `{ providerId: null, label: 'Default model' }`.
 */
export function resolveModelProvider(
  model: string | null | undefined,
  runtime?: string | null,
): ResolvedModelProvider {
  if (!model) return { providerId: null, label: 'Default model' }
  const label = findNativeModelLabel(model) ?? findModelLabel(model) ?? prettifyModelId(model)

  let providerId: ProviderId | null = null
  if (runtime === 'clawboo-native') {
    // Native knows its provider directly; but nativeModelExec collapses any
    // unrecognized `vendor/model` to 'openrouter' — recover the real vendor.
    providerId = normalizeProviderId(nativeModelExec(model)?.primaryProvider)
    if ((!providerId || providerId === 'openrouter') && model.includes('/')) {
      providerId = providerFromModelId(model) ?? providerId
    }
  }
  if (!providerId) providerId = providerFromModelId(model)
  // OpenRouter-routed with no pinnable maker → the OpenRouter brand (a real,
  // honest mark) rather than a generic glyph.
  if (!providerId && (runtime === 'hermes' || model.toLowerCase().startsWith('openrouter/'))) {
    providerId = 'openrouter'
  }
  return { providerId, label }
}
