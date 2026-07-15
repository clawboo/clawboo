// Live model lists for the native providers that need an API key to enumerate
// their models — Anthropic + OpenAI. Mirrors `openrouterModels.ts` (module cache
// + TTL + AbortController timeout + last-good-on-failure, never throws), but keyed
// by a hash of the API key so a changed key refetches. The key is used ONLY for
// the outbound fetch — never logged, persisted, or returned (secretsVault invariant).

import { createHash } from 'node:crypto'

import { NATIVE_COMPAT_PROVIDERS } from './runtimes/native/nativeProviders'

export interface ModelOption {
  id: string
  label: string
}

const CACHE_TTL_MS = 30 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

interface CacheEntry {
  models: ModelOption[]
  at: number
  keyHash: string
}
const cache = new Map<string, CacheEntry>()

function keyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

async function timedFetch(url: string, headers: Record<string, string>): Promise<Response | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: ctl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// OpenAI's /v1/models returns embeddings, tts, whisper, dall-e, moderation, etc.
// alongside chat models — keep only the chat/reasoning families.
const OPENAI_CHAT_RE = /^(gpt-|o1|o3|o4|chatgpt-)/i
const OPENAI_DROP_RE =
  /(embedding|whisper|tts|dall-?e|moderation|audio|realtime|image|transcribe|search|babbage|davinci|-instruct|codex)/i

async function fetchAnthropic(key: string): Promise<ModelOption[] | null> {
  const res = await timedFetch('https://api.anthropic.com/v1/models?limit=100', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  })
  if (!res || !res.ok) return null
  const body = (await res.json().catch(() => null)) as {
    data?: { id?: unknown; display_name?: unknown; created_at?: unknown }[]
  } | null
  if (!body || !Array.isArray(body.data)) return null
  return body.data
    .filter((m): m is { id: string; display_name?: string; created_at?: string } => typeof m.id === 'string')
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .map((m) => ({ id: m.id, label: (m.display_name?.trim() || m.id) as string }))
}

async function fetchOpenAI(key: string): Promise<ModelOption[] | null> {
  const res = await timedFetch('https://api.openai.com/v1/models', {
    Authorization: `Bearer ${key}`,
  })
  if (!res || !res.ok) return null
  const body = (await res.json().catch(() => null)) as {
    data?: { id?: unknown; created?: unknown }[]
  } | null
  if (!body || !Array.isArray(body.data)) return null
  return body.data
    .filter(
      (m): m is { id: string; created?: number } =>
        typeof m.id === 'string' && OPENAI_CHAT_RE.test(m.id) && !OPENAI_DROP_RE.test(m.id),
    )
    .sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))
    .map((m) => ({ id: m.id, label: m.id }))
}

// Non-chat models a bare OpenAI-compat `/models` list may include — dropped so
// the picker shows usable chat/reasoning models.
const COMPAT_DROP_RE = /(embedding|embed|rerank|whisper|tts|audio|dall-?e|image|vision-encoder|moderation|guard|transcribe|-ocr|bge-|nomic-)/i

/** Generic OpenAI-compatible `/models` reader (Google, xAI, Groq, Mistral, …). */
async function fetchOpenAiCompat(baseURL: string, key: string): Promise<ModelOption[] | null> {
  const res = await timedFetch(`${baseURL}/models`, { Authorization: `Bearer ${key}` })
  if (!res || !res.ok) return null
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null
  if (!body || !Array.isArray(body.data)) return null
  return body.data
    .filter((m): m is { id: string } => typeof m.id === 'string' && !COMPAT_DROP_RE.test(m.id))
    .map((m) => ({ id: m.id, label: m.id }))
}

const FETCHERS: Record<string, (key: string) => Promise<ModelOption[] | null>> = {
  anthropic: fetchAnthropic,
  openai: fetchOpenAI,
  // Each extra OpenAI-compatible provider reads its own `/models` endpoint.
  ...Object.fromEntries(
    NATIVE_COMPAT_PROVIDERS.map((p) => [p.id, (key: string) => fetchOpenAiCompat(p.baseURL, key)]),
  ),
}

/** Whether a provider supports a key-authenticated live model list here. */
export function hasLiveModels(provider: string): boolean {
  return provider in FETCHERS
}

/** Fetch a provider's live model list using `key`. Cached per (provider, key),
 *  serves last-good on failure, returns [] for an unsupported provider or a
 *  total failure with no prior cache. Never throws. */
export async function fetchNativeModelsForKey(provider: string, key: string): Promise<ModelOption[]> {
  const fetcher = FETCHERS[provider]
  if (!fetcher || !key) return []
  const kh = keyHash(key)
  const hit = cache.get(provider)
  if (hit && hit.keyHash === kh && Date.now() - hit.at < CACHE_TTL_MS) return hit.models
  const fetched = await fetcher(key)
  if (fetched && fetched.length > 0) {
    cache.set(provider, { models: fetched, at: Date.now(), keyHash: kh })
    return fetched
  }
  if (hit && hit.keyHash === kh) return hit.models // last-good for the same key
  return []
}
