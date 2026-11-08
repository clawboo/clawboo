// Dynamic OpenRouter model catalog — fetched live from OpenRouter's public models
// endpoint (no key required to LIST) and cached in-process, so the native
// OpenRouter pickers always reflect what OpenRouter currently serves instead of a
// hardcoded handful. Mirrors modelCache.ts (module cache + TTL, serves the last
// good cache on failure). The client falls back to a small hardcoded list while
// this loads or if the fetch fails, so a picker is never empty.

import type { ModelOption } from './modelCache'
import { providerBaseUrl, providerBaseUrlOverride } from './providerBaseUrls'
import { resolveRuntimeKey } from './secretsVault'
const CACHE_TTL = 30 * 60 * 1000 // 30 min — OpenRouter's catalog changes slowly
const FETCH_TIMEOUT_MS = 8000

let cached: ModelOption[] | null = null
let cacheTime = 0
/** The base URL `cached` came from: another one (an administrator's gateway) is another list. */
let cachedBase: string | null = null

interface OpenRouterApiModel {
  id?: string
  name?: string
  architecture?: {
    output_modalities?: string[]
    modality?: string
  }
}

/** Keep only text-capable models — a text agent can't drive an image/audio-only
 *  model. Defensive: an entry missing architecture data is kept. */
function isTextModel(m: OpenRouterApiModel): boolean {
  const arch = m.architecture
  if (!arch) return true
  if (Array.isArray(arch.output_modalities)) return arch.output_modalities.includes('text')
  if (typeof arch.modality === 'string') return arch.modality.includes('text')
  return true
}

/** The live OpenRouter model list (flat, sorted by label), cached in-process.
 *  Returns the last good cache on any failure; null only when we have never
 *  successfully fetched (the client then uses its hardcoded fallback). */
export async function fetchOpenRouterModels(): Promise<ModelOption[] | null> {
  const now = Date.now()
  // OpenRouter's own address, or the gateway an administrator pointed it at
  // (OPENROUTER_BASE_URL), so the list matches what native runs can reach.
  const base = providerBaseUrl('openrouter')
  if (cachedBase !== base) {
    cached = null
    cachedBase = base
  }
  if (cached && now - cacheTime < CACHE_TTL) return cached

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    // OpenRouter lists its models to anyone. A gateway may not, so it gets the
    // key the runs send it anyway; the public list is still asked with none.
    const key = providerBaseUrlOverride('openrouter')
      ? resolveRuntimeKey('OPENROUTER_API_KEY')
      : null
    const res = await fetch(`${base}/models`, {
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      // The request may carry the key, so it never follows a redirect elsewhere.
      redirect: 'error',
      signal: controller.signal,
    })
    if (!res.ok) return cached
    const body = (await res.json()) as { data?: OpenRouterApiModel[] }
    const data = Array.isArray(body.data) ? body.data : []
    const models = data
      .filter(
        (m): m is OpenRouterApiModel & { id: string } => typeof m.id === 'string' && isTextModel(m),
      )
      .map((m) => ({ id: m.id, label: m.name?.trim() || m.id }))
      .sort((a, b) => a.label.localeCompare(b.label))
    if (models.length === 0) return cached
    cached = models
    cacheTime = now
    return cached
  } catch {
    return cached
  } finally {
    clearTimeout(timer)
  }
}
