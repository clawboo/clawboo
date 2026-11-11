// Defensive REST + SSE client for the non-OpenClaw runtimes (best-effort, typed,
// never throws to the caller). Drives the connection card + the Runtimes panel +
// the onboarding step.

import { apiFetch } from './config'
import { consumeApiSSE, type SSEHandlers } from './sse'

/** The connectable-runtime id union — the runtimes a user installs / connects via
 *  `/api/runtimes`. Distinct from `@clawboo/agent-registry`'s broad `RuntimeId`
 *  (which includes `openclaw` + an open union). Owned here so the client and the
 *  web catalog share ONE definition (the catalog re-exports this). */
export type RuntimeId = 'claude-code' | 'codex' | 'hermes' | 'clawboo-native'

export type ConnectionState = 'not-installed' | 'needs-auth' | 'needs-login' | 'ready' | 'unknown'

/** What a full runtime Disconnect does to the vault (`GET /api/runtimes`). Only
 *  slots that hold a key are listed. */
export interface RuntimeDisconnectPlan {
  /** Saved keys it deletes: no other runtime reads them. */
  removes: string[]
  /** Saved keys it keeps, each with the other runtimes (by name) that read it. */
  keeps: { envVar: string; sharedWith: string[] }[]
}

export interface RuntimeStatus {
  id: RuntimeId
  name?: string
  installed?: boolean
  binPath?: string | null
  /** Where `binPath` came from: the runtime's CLI, or (Claude Code) the Agent
   *  SDK's own binary, which is what a run starts. */
  binSource?: 'cli' | 'agent-sdk' | null
  /** How a person types the runtime's command in a terminal: the full path of
   *  the launcher for a copy Clawboo installed into its runtimes folder (not on
   *  their PATH), else the bare name. Null for a runtime with no command. */
  terminalCommand?: string | null
  /** Why Clawboo's own copy cannot be used although one is on record (its
   *  Node.js removed by an upgrade, say), or null. */
  installProblem?: string | null
  authKind?: 'api-key' | 'oauth' | 'none'
  envVar?: string | null
  hasCredential?: boolean
  /** A key for this runtime is saved in the vault (not just in the environment).
   *  With `hasCredential` false it means the runtime was disconnected and kept a
   *  key another runtime also uses, which a keyless connect can reuse. */
  hasVaultCredential?: boolean
  /** What a full Disconnect would delete and keep, by env-var name. */
  disconnectPlan?: RuntimeDisconnectPlan
  /** Hermes-only: a ChatGPT-subscription login (`hermes login --provider
   *  openai-codex`) is present — gates the subscription model group. */
  codexAuth?: boolean
  /** Native-only: local Ollama is set up (chosen in onboarding or the providers
   *  manager, or configured with OLLAMA_BASE_URL). It readies the runtime without
   *  a key, so `hasCredential` can be false while `connectionState` is 'ready'. */
  ollamaConnected?: boolean
  /** Codex-only: the installed CLI cannot read the ChatGPT plan's current models,
   *  so its runs fail until it is updated (reinstalling updates it). */
  updateRequired?: boolean
  /** Codex-only: the installed CLI's version, when known. */
  cliVersion?: string | null
  /** Hermes-only: this Hermes was installed without its ACP mode (the `acp`
   *  extra), so its runs report only at the end and a comment mid-run stops and
   *  resumes them. Reinstalling adds it. Absent until Hermes has been asked. */
  acpMissing?: boolean
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
    /** How a comment reaches a running task: `live` joins the turn,
     *  `interrupt-resume` stops and resumes the run, `none` (or absent) waits for
     *  the next run. Hermes's follows the way its runs go now. */
    steering?: 'live' | 'interrupt-resume' | 'none'
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
    const res = await apiFetch('/api/runtimes')
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
 *  caller can cancel. */
export function installRuntime(id: RuntimeId, handlers: SSEHandlers): AbortController {
  return consumeApiSSE(`/api/runtimes/${id}/install`, { method: 'POST' }, handlers)
}

/** The UI-driven ChatGPT sign-in: the server spawns the OFFICIAL CLI's login
 *  command and relays its user-facing output (`device-code {url,code}` /
 *  `auth-url {url}` / `output` / `complete {loggedIn}` / typed `error`s incl.
 *  NOT_INSTALLED + UNSUPPORTED_PLATFORM). Aborting the returned controller is
 *  CANCEL — the server kills the whole child tree on disconnect. */
export type CliLoginTool = 'codex' | 'hermes' | 'openclaw'

export function startCliLogin(tool: CliLoginTool, handlers: SSEHandlers): AbortController {
  return consumeApiSSE(`/api/auth/cli-login/${tool}`, { method: 'POST' }, handlers)
}

export interface ConnectResult {
  ok: boolean
  connectionState?: ConnectionState
  loginCommand?: string
  error?: string
}

/** POST /api/runtimes/:id/connect — writes the provider key to the vault. The
 *  optional `provider` lets the multi-provider native runtime route the key to
 *  the right env-var slot (OpenAI / OpenRouter, not always ANTHROPIC_API_KEY).
 *  An EMPTY `apiKey` with a `provider` is the keyless REUSE form: reconnect the
 *  native runtime with a key that already exists for that provider (the
 *  Providers hub / OpenClaw .env) instead of demanding a re-paste. */
export async function connectRuntime(
  id: RuntimeId,
  apiKey: string,
  provider?: string,
): Promise<ConnectResult> {
  try {
    const res = await apiFetch(`/api/runtimes/${id}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(apiKey ? { apiKey } : {}),
        ...(provider ? { provider } : {}),
      }),
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
  /** Ollama only: the requested model, when the daemon answers but hasn't pulled it. */
  missingModel?: string
}

/** POST /api/runtimes/clawboo-native/healthcheck — verifies a pasted provider
 *  key with a single models-list GET. The key is never persisted; the response
 *  carries only { ok, error?, missingModel? }. For Ollama, `model` is also
 *  checked against the models the local daemon has pulled. */
export async function healthcheckNativeKey(
  provider: string,
  apiKey: string,
  model?: string,
): Promise<HealthcheckResult> {
  try {
    const res = await apiFetch('/api/runtimes/clawboo-native/healthcheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey, ...(model ? { model } : {}) }),
    })
    const body = (await res.json().catch(() => ({}))) as HealthcheckResult
    return {
      ok: res.ok && body.ok === true,
      error: body.error,
      ...(typeof body.missingModel === 'string' ? { missingModel: body.missingModel } : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** POST /api/runtimes/:id/disconnect: clears the stored credential. With
 *  `provider: 'ollama'` (native only) it removes just the local-Ollama choice and
 *  leaves every key alone. */
export async function disconnectRuntime(
  id: RuntimeId,
  provider?: 'ollama',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(
      `/api/runtimes/${id}/disconnect`,
      provider
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider }),
          }
        : { method: 'POST' },
    )
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    const ok = res.ok && body.ok !== false
    // Surface a real reason on failure so the caller can show it (don't swallow).
    return ok ? { ok } : { ok, error: body.error ?? `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** POST /api/runtimes/:id/logout — sign out an OAUTH runtime (Codex) via the
 *  CLI's own `logout`. Signs out the shared ChatGPT subscription. */
export async function signOutRuntime(id: RuntimeId): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`/api/runtimes/${id}/logout`, { method: 'POST' })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    const ok = res.ok && body.ok !== false
    return ok ? { ok } : { ok, error: body.error ?? `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface CodexModelOption {
  /** The bare backend id (`gpt-5.6-luna`). */
  id: string
  label: string
}

export interface CodexModels {
  /** The ChatGPT plan's models, most capable first; empty when unknown. */
  models: CodexModelOption[]
  /** The model a run uses when none is pinned, or null when unknown. */
  defaultModel: string | null
  /** The installed Codex CLI is too old for the plan's current models. */
  updateRequired: boolean
}

/** GET /api/runtimes/codex/models → the models the user's ChatGPT subscription can
 *  run, read live from their Codex CLI. Empty on any failure (the pickers then
 *  offer only the plan default), so this never throws. */
export async function fetchCodexModels(): Promise<CodexModels> {
  const empty: CodexModels = { models: [], defaultModel: null, updateRequired: false }
  try {
    const res = await apiFetch('/api/runtimes/codex/models')
    if (!res.ok) return empty
    const body = (await res.json()) as Partial<CodexModels>
    return {
      models: Array.isArray(body.models) ? body.models : [],
      defaultModel: typeof body.defaultModel === 'string' ? body.defaultModel : null,
      updateRequired: body.updateRequired === true,
    }
  } catch {
    return empty
  }
}

export interface OpenRouterModelOption {
  id: string
  label: string
}

/** GET /api/runtimes/openrouter/models → the live OpenRouter model list (flat,
 *  sorted by label). Falls back to [] on any non-ok so the caller can use its
 *  hardcoded fallback while this loads or if OpenRouter is unreachable. */
export async function fetchOpenRouterModels(): Promise<OpenRouterModelOption[]> {
  try {
    const res = await apiFetch('/api/runtimes/openrouter/models')
    if (!res.ok) return []
    const body = (await res.json()) as { models?: OpenRouterModelOption[] }
    return body.models ?? []
  } catch {
    return []
  }
}
