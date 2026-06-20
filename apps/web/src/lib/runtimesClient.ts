// Defensive REST + SSE client for the non-OpenClaw runtimes (mirrors the
// boardClient pattern: best-effort, typed, never throws to the caller). Drives
// the connection card + the Runtimes panel + the onboarding step.

import { consumeSSE, type SSEHandlers } from './sseClient'
import type { RuntimeId } from '../features/runtimes/runtimeCatalog'

export type ConnectionState = 'not-installed' | 'needs-auth' | 'needs-login' | 'ready' | 'unknown'

export interface RuntimeStatus {
  id: RuntimeId
  name?: string
  installed?: boolean
  binPath?: string | null
  authKind?: 'api-key' | 'oauth' | 'none'
  envVar?: string | null
  hasCredential?: boolean
  installCommand?: string | null
  builtIn?: boolean
  docsUrl?: string
  connectionState?: ConnectionState
  capabilities?: {
    streaming?: boolean
    mcp?: boolean
    worktrees?: boolean
    resume?: boolean
    toolApproval?: boolean
    models?: string[]
    // Integration-depth seam (executor Capabilities). `runtimeClass` drives the
    // diagnostics depth badge; the rest render the native-correct facts. All
    // optional — an adapter that omits them resolves to a wrapped one-shot.
    contextWindowTokens?: number
    runtimeClass?: RuntimeClass
    nativeHome?: { scope: 'per-identity' | 'per-run'; persist: boolean }
    nativeSkills?: 'preserve' | 'none'
    nativeMemory?: 'preserve' | 'none'
    nativeChannels?: 'gateway' | 'none'
  }
  health?: { ok: boolean; message?: string }
}

/** Integration depth — derived from `capabilities.runtimeClass` (omitted ⇒
 *  'wrapped-oneshot'). OpenClaw = connected-substrate; the native runtime =
 *  native; the CLI runtimes = wrapped-oneshot. */
export type RuntimeClass = 'wrapped-oneshot' | 'connected-substrate' | 'native'

/** GET /api/runtimes → the available runtimes (enriched). Falls back to [] on any
 *  non-ok, so the panel renders catalog cards. */
export async function fetchRuntimes(): Promise<RuntimeStatus[]> {
  try {
    const res = await fetch('/api/runtimes')
    if (!res.ok) return []
    const body = (await res.json()) as { runtimes?: RuntimeStatus[] }
    return body.runtimes ?? []
  } catch {
    return []
  }
}

/** Re-fetch status for a single runtime (used after install/connect/login). */
export async function recheckRuntime(id: RuntimeId): Promise<RuntimeStatus | null> {
  const all = await fetchRuntimes()
  return all.find((r) => r.id === id) ?? null
}

/** Install a runtime CLI via the SSE endpoint. Returns the AbortController so the
 *  caller can cancel; mirrors the onboarding InstallStep usage of consumeSSE. */
export function installRuntime(id: RuntimeId, handlers: SSEHandlers): AbortController {
  return consumeSSE(`/api/runtimes/${id}/install`, { method: 'POST' }, handlers)
}

export interface ConnectResult {
  ok: boolean
  connectionState?: ConnectionState
  loginCommand?: string
  error?: string
}

/** POST /api/runtimes/:id/connect — writes the provider key to the vault. The
 *  optional `provider` lets the multi-provider native runtime route the key to
 *  the right env-var slot (OpenAI / OpenRouter, not always ANTHROPIC_API_KEY). */
export async function connectRuntime(
  id: RuntimeId,
  apiKey: string,
  provider?: string,
): Promise<ConnectResult> {
  try {
    const res = await fetch(`/api/runtimes/${id}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider ? { apiKey, provider } : { apiKey }),
    })
    const body = (await res.json().catch(() => ({}))) as ConnectResult
    return { ...body, ok: res.ok && body.ok !== false }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface HealthcheckResult {
  ok: boolean
  error?: string
}

/** POST /api/runtimes/clawboo-native/healthcheck — verifies a pasted provider
 *  key with a single models-list GET. The key is never persisted; the response
 *  carries only { ok, error? }. */
export async function healthcheckNativeKey(
  provider: string,
  apiKey: string,
): Promise<HealthcheckResult> {
  try {
    const res = await fetch('/api/runtimes/clawboo-native/healthcheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey }),
    })
    const body = (await res.json().catch(() => ({}))) as HealthcheckResult
    return { ok: res.ok && body.ok === true, error: body.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** POST /api/runtimes/:id/disconnect — clears the stored credential. */
export async function disconnectRuntime(id: RuntimeId): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/runtimes/${id}/disconnect`, { method: 'POST' })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    const ok = res.ok && body.ok !== false
    // Surface a real reason on failure so the caller can show it (don't swallow).
    return ok ? { ok } : { ok, error: body.error ?? `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
