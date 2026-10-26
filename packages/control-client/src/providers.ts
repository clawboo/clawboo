// Defensive REST client for the Settings → Providers hub (never throws to the
// caller). A key VALUE is never returned by the server — these carry only status.

import { apiFetch } from './config'

export interface ProviderStatus {
  id: string
  connected: boolean
  poweredRuntimes: string[]
}

export interface ProviderMutationResult {
  ok: boolean
  providers?: ProviderStatus[]
  error?: string
}

export interface ProviderModelOption {
  id: string
  label: string
}

/** GET /api/providers/:id/models — live model list via the stored key. [] on any
 *  error / keyless / unsupported provider (caller falls back to its static list). */
export async function fetchProviderModels(id: string): Promise<ProviderModelOption[]> {
  try {
    const res = await apiFetch(`/api/providers/${id}/models`)
    if (!res.ok) return []
    const body = (await res.json()) as { models?: ProviderModelOption[] }
    return body.models ?? []
  } catch {
    return []
  }
}

export interface OllamaModelList {
  /** True when the local Ollama answered, false when it didn't, null when the
   *  request itself failed (so nothing is known either way). */
  reachable: boolean | null
  /** The chat models it has pulled, newest first. */
  models: ProviderModelOption[]
  /** The model a new agent would get, or null when unknown. */
  recommendedModel: string | null
}

/** GET /api/providers/ollama/models: the chat models the local Ollama has pulled.
 *  Never throws: a failed request reads as `reachable: null`. */
export async function fetchOllamaModels(): Promise<OllamaModelList> {
  try {
    const res = await apiFetch('/api/providers/ollama/models')
    if (!res.ok) return { reachable: null, models: [], recommendedModel: null }
    const body = (await res.json()) as {
      models?: ProviderModelOption[]
      reachable?: unknown
      recommendedModel?: unknown
    }
    return {
      reachable: typeof body.reachable === 'boolean' ? body.reachable : null,
      models: Array.isArray(body.models) ? body.models : [],
      recommendedModel:
        typeof body.recommendedModel === 'string' && body.recommendedModel
          ? body.recommendedModel
          : null,
    }
  } catch {
    return { reachable: null, models: [], recommendedModel: null }
  }
}

/** POST /api/providers/:id/models — live model list for a PASTED (unsaved) key,
 *  for the onboarding step. The key is used for one fetch only, never persisted. */
export async function fetchProviderModelsWithKey(
  id: string,
  apiKey: string,
): Promise<ProviderModelOption[]> {
  try {
    const res = await apiFetch(`/api/providers/${id}/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { models?: ProviderModelOption[] }
    return body.models ?? []
  } catch {
    return []
  }
}

/** GET /api/providers → the provider connection list. Falls back to [] on error. */
export async function fetchProviders(): Promise<ProviderStatus[]> {
  try {
    const res = await apiFetch('/api/providers')
    if (!res.ok) return []
    const body = (await res.json()) as { providers?: ProviderStatus[] }
    return body.providers ?? []
  } catch {
    return []
  }
}

/** POST /api/providers/:id/connect — stores the key in both stores (vault + OpenClaw .env). */
export async function connectProvider(id: string, apiKey: string): Promise<ProviderMutationResult> {
  try {
    const res = await apiFetch(`/api/providers/${id}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
    const body = (await res.json().catch(() => ({}))) as ProviderMutationResult
    return { ...body, ok: res.ok && body.ok !== false }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** POST /api/providers/:id/disconnect — clears the key from both stores. */
export async function disconnectProvider(id: string): Promise<ProviderMutationResult> {
  try {
    const res = await apiFetch(`/api/providers/${id}/disconnect`, { method: 'POST' })
    const body = (await res.json().catch(() => ({}))) as ProviderMutationResult
    return { ...body, ok: res.ok && body.ok !== false }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
