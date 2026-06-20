// ─── Non-OpenClaw runtimes REST ─────────────────────────
// Thin HTTP layer over the server-side executor runner + the runtime descriptor.
// Lists the available runtimes (capabilities + health + install/auth status),
// installs a runtime CLI (SSE), connects/disconnects its provider key (encrypted
// vault), and runs a board task on one of them.

import { spawn, type ChildProcess } from 'node:child_process'

import type { Request, Response } from 'express'

import { envVarForProvider } from '@clawboo/adapter-native'
import { createDb } from '@clawboo/db'
import { breakerConfigSchema } from '@clawboo/governance'

import { getDbPath } from '../lib/db'
import { runTaskOnRuntime } from '../lib/executorRunner'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { findExecutable, isWindows, resolveRuntimeBin, resolveShimName } from '../lib/platform'
import { adapterFactoryFor, enabledRuntimeIds } from '../lib/runtimes'
import {
  deriveConnectionState,
  getDescriptor,
  isRuntimeId,
  NON_OPENCLAW_RUNTIME_IDS,
  type NonOpenClawRuntimeId,
  type RuntimeDescriptor,
} from '../lib/runtimes/descriptor'
import {
  deleteRuntimeSecret,
  getRuntimeSecret,
  resolveRuntimeKey,
  setRuntimeSecret,
} from '../lib/secretsVault'

/** Validate the :id param against the runtime set; 404s + returns null on miss. */
function requireRuntimeId(req: Request, res: Response): NonOpenClawRuntimeId | null {
  const id = String(req.params['id'] ?? '')
  if (!isRuntimeId(id)) {
    res.status(404).json({ error: `unknown runtime '${id}'` })
    return null
  }
  return id
}

/** SSE line writer — mirrors system.ts; kept local to avoid coupling. */
function sendEvent(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/** No-secret view of a descriptor (envVar is the variable NAME, not the value). */
function publicDescriptor(d: RuntimeDescriptor): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    healthBin: d.healthBin,
    packageManager: d.packageManager,
    installCommand: d.installCommand,
    builtIn: d.builtIn,
    authKind: d.authKind,
    envVar: d.envVar,
    docsUrl: d.docsUrl,
    headlessAuth: d.headlessAuth,
  }
}

/** Per-runtime install + auth status, WITHOUT exposing any secret value. */
function runtimeStatus(id: NonOpenClawRuntimeId): Record<string, unknown> {
  const d = getDescriptor(id)
  // Built-in runtimes ship inside the server: always installed, no binary.
  const binPath = d.builtIn ? null : d.healthBin ? resolveRuntimeBin(d.healthBin) : null
  const installed = d.builtIn ? true : Boolean(binPath)
  // Presence only — resolveRuntimeKey returns the value but we never expose it.
  // A multi-provider runtime is connected when ANY of its env vars resolves.
  const envVars = [d.envVar, ...(d.altEnvVars ?? [])].filter((v): v is string => Boolean(v))
  const hasCredential = envVars.some((v) => Boolean(resolveRuntimeKey(v)))
  // Vault-only signal: a credential DELIBERATELY connected during onboarding (written
  // to the encrypted vault), as opposed to an ambient `process.env` shell var that
  // `resolveRuntimeKey` ALSO honors. The onboarding native-skip decision reads THIS so
  // a bare exported `ANTHROPIC_API_KEY` doesn't masquerade as "completed onboarding".
  const hasVaultCredential = envVars.some((v) => Boolean(getRuntimeSecret(v)))
  return {
    name: d.name,
    installed,
    binPath: binPath ?? null,
    builtIn: d.builtIn,
    authKind: d.authKind,
    envVar: d.envVar,
    hasCredential,
    hasVaultCredential,
    installCommand: d.installCommand,
    docsUrl: d.docsUrl,
    connectionState: deriveConnectionState(d, installed, hasCredential),
  }
}

// ─── GET /api/runtimes ───────────────────────────────────────────────────────
// Lists each runtime with its capabilities + health (UNCHANGED shape:
// id/participantKind/capabilities/health first, back-compat) + the new additive
// install/auth status. `available` advertises the full catalog so the UI can
// render "available to add" cards for runtimes the user hasn't connected yet.
export async function runtimesListGET(_req: Request, res: Response): Promise<void> {
  try {
    const runtimes = await Promise.all(
      enabledRuntimeIds().map(async (id) => {
        const adapter = adapterFactoryFor(id)({})
        return {
          id,
          participantKind: adapter.participantKind,
          capabilities: adapter.capabilities(),
          health: await adapter.health(),
          ...runtimeStatus(id),
        }
      }),
    )
    const available = NON_OPENCLAW_RUNTIME_IDS.map((id) => publicDescriptor(getDescriptor(id)))
    res.json({ runtimes, available })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}

// ─── POST /api/runtimes/:id/install (SSE) ────────────────────────────────────
// Installs the runtime's CLI. npm runtimes → `npm install -g <pkg>`; the pip
// runtime → pipx-preferred with a PEP-668 `--break-system-packages` fallback.
// Mirrors system.ts `installOpenclawPOST`: text/event-stream, progress/output/
// complete/error events, child.kill() on connection close, synchronous-throw
// guard.
export function runtimesInstallPOST(req: Request, res: Response): void {
  const id = requireRuntimeId(req, res)
  if (!id) return
  const d = getDescriptor(id)

  // A built-in runtime ships inside the server — a clean 400 (plain JSON, the
  // SSE stream never opens). The UI never offers Install for it because its
  // connectionState is never 'not-installed'.
  if (d.builtIn || !d.packageManager) {
    res.status(400).json({ error: `${d.name} is built in — nothing to install` })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sendEvent(res, { type: 'progress', step: 'installing', message: `Installing ${d.name}…` })

  // One res.on('close') handler kills whichever child is active (the pip path
  // may spawn a second child for the PEP-668 retry).
  const ctl: { child: ChildProcess | null } = { child: null }
  res.on('close', () => {
    if (ctl.child && !ctl.child.killed) ctl.child.kill()
  })

  if (d.packageManager === 'npm') installViaNpm(res, d, ctl)
  else installViaPip(res, d, ctl)
}

/** On a successful install: flip the flag on (live; runtime flags need no
 *  restart), then report binary presence. */
function finishInstall(res: Response, d: RuntimeDescriptor): void {
  // No cache to bust — resolveRuntimeBin probes PATH + user-install dirs live
  // (it's what finds Hermes in the Python user-site bin off PATH).
  if (d.healthBin && resolveRuntimeBin(d.healthBin)) {
    sendEvent(res, { type: 'complete', success: true })
  } else {
    sendEvent(res, {
      type: 'complete',
      success: true,
      warning: `Installed, but '${String(d.healthBin)}' isn't on PATH or the known user-install dirs yet. Restart the server if it stays missing.`,
    })
  }
  res.end()
}

/** Stream a child's stdout/stderr as SSE; finish via finishInstall / error. */
function streamInstallChild(res: Response, child: ChildProcess, d: RuntimeDescriptor): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean))
      sendEvent(res, { type: 'output', line })
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (text.includes('EACCES') || text.toLowerCase().includes('permission denied')) {
      sendEvent(res, {
        type: 'error',
        code: 'EACCES',
        message: `Permission denied. A global install may require elevated permissions. Try: sudo ${d.installCommand}`,
      })
    }
    for (const line of text.split('\n').filter(Boolean)) sendEvent(res, { type: 'output', line })
  })
  child.on('error', (err) => {
    sendEvent(res, { type: 'error', code: 'SPAWN_ERROR', message: String(err) })
    res.end()
  })
  child.on('close', (code) => {
    if (code === 0) finishInstall(res, d)
    else {
      sendEvent(res, {
        type: 'error',
        code: `EXIT_${code}`,
        message: `Installation failed with exit code ${code}`,
      })
      res.end()
    }
  })
}

function installViaNpm(
  res: Response,
  d: RuntimeDescriptor,
  ctl: { child: ChildProcess | null },
): void {
  if (!resolveRuntimeBin('npm') && !findExecutable('npm')) {
    sendEvent(res, {
      type: 'error',
      code: 'NPM_MISSING',
      message: 'npm not found. Install Node.js (which bundles npm) and retry.',
    })
    res.end()
    return
  }
  try {
    ctl.child = spawn(resolveShimName('npm'), ['install', '-g', d.pkg ?? ''], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      windowsHide: isWindows,
    })
  } catch (err) {
    sendEvent(res, {
      type: 'error',
      code: 'SPAWN_THROW',
      message: err instanceof Error ? err.message : String(err),
    })
    res.end()
    return
  }
  streamInstallChild(res, ctl.child, d)
}

function installViaPip(
  res: Response,
  d: RuntimeDescriptor,
  ctl: { child: ChildProcess | null },
): void {
  // Prefer pipx (sidesteps PEP-668 entirely).
  const pipx = resolveRuntimeBin('pipx') ?? findExecutable('pipx')
  if (pipx) {
    sendEvent(res, { type: 'progress', step: 'installing', message: 'Installing via pipx…' })
    try {
      ctl.child = spawn(pipx, ['install', d.pkg ?? ''], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWindows,
        windowsHide: isWindows,
      })
    } catch (err) {
      sendEvent(res, {
        type: 'error',
        code: 'SPAWN_THROW',
        message: err instanceof Error ? err.message : String(err),
      })
      res.end()
      return
    }
    streamInstallChild(res, ctl.child, d)
    return
  }
  // Else `python -m pip install --user`, retrying once with
  // --break-system-packages if the env is PEP-668 externally-managed.
  const python = findExecutable('python3') ?? findExecutable('python')
  if (!python) {
    sendEvent(res, {
      type: 'error',
      code: 'PYTHON_MISSING',
      message:
        'Python 3 (with pip or pipx) not found. Install Python 3 and retry. Recommended: pipx.',
    })
    res.end()
    return
  }
  runPipUser(res, d, ctl, python, false)
}

function runPipUser(
  res: Response,
  d: RuntimeDescriptor,
  ctl: { child: ChildProcess | null },
  python: string,
  breakSystem: boolean,
): void {
  if (breakSystem) {
    sendEvent(res, {
      type: 'progress',
      step: 'retrying',
      message: 'Externally-managed environment detected; retrying with --break-system-packages…',
    })
  }
  const args = [
    '-m',
    'pip',
    'install',
    '--user',
    ...(breakSystem ? ['--break-system-packages'] : []),
    d.pkg ?? '',
  ]
  try {
    ctl.child = spawn(python, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      windowsHide: isWindows,
    })
  } catch (err) {
    sendEvent(res, {
      type: 'error',
      code: 'SPAWN_THROW',
      message: err instanceof Error ? err.message : String(err),
    })
    res.end()
    return
  }
  const child = ctl.child
  let sawPep668 = false
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean))
      sendEvent(res, { type: 'output', line })
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (text.includes('externally-managed-environment')) sawPep668 = true
    for (const line of text.split('\n').filter(Boolean)) sendEvent(res, { type: 'output', line })
  })
  child.on('error', (err) => {
    sendEvent(res, { type: 'error', code: 'SPAWN_ERROR', message: String(err) })
    res.end()
  })
  child.on('close', (code) => {
    if (code === 0) {
      finishInstall(res, d)
      return
    }
    if (sawPep668 && !breakSystem) {
      runPipUser(res, d, ctl, python, true)
      return
    }
    sendEvent(res, {
      type: 'error',
      code: `EXIT_${code}`,
      message: `Installation failed with exit code ${code}`,
    })
    res.end()
  })
}

// ─── POST /api/runtimes/:id/connect ──────────────────────────────────────────
// api-key runtimes: { apiKey } → encrypted vault + flag on. oauth runtimes
// (codex): a key-less no-op that returns needs-login + the terminal command.
// NEVER echoes the key in the response.
export function runtimesConnectPOST(req: Request, res: Response): void {
  const id = requireRuntimeId(req, res)
  if (!id) return
  const d = getDescriptor(id)

  if (d.authKind === 'oauth') {
    // Codex can't be connected with a pasted key — install then `codex login`.
    res.json({
      ok: true,
      connectionState: 'needs-login',
      loginCommand: `${d.healthBin ?? d.id} login`,
    })
    return
  }

  if (d.authKind === 'none' || !d.envVar) {
    res.json({ ok: true, connectionState: runtimeStatus(id)['connectionState'] })
    return
  }

  const body = (req.body ?? {}) as { apiKey?: unknown; provider?: unknown }

  // The native runtime is multi-provider: a pasted key must land in the vault
  // slot for the CHOSEN provider (OpenAI/OpenRouter keys would otherwise be
  // written to ANTHROPIC_API_KEY). `null` = a keyless provider (Ollama) — there
  // is nothing to store; connectionState is re-derived from what already resolves.
  const targetEnvVar = resolveConnectEnvVar(d, body.provider)
  if (targetEnvVar === null) {
    res.json({ ok: true, connectionState: runtimeStatus(id)['connectionState'] })
    return
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey) {
    res.status(400).json({ error: 'apiKey is required' })
    return
  }
  setRuntimeSecret(targetEnvVar, apiKey)
  // Re-derive (never echo the key). With the key now in the vault and the CLI
  // installed, connectionState becomes 'ready'.
  res.json({
    ok: true,
    connectionState: runtimeStatus(id)['connectionState'],
  })
}

/** The vault env-var a connect request targets. Non-native runtimes always use
 *  their single descriptor envVar. The native runtime maps the chosen provider
 *  → its conventional env var (validated against the runtime's known set);
 *  `null` means a keyless provider (Ollama) with nothing to store. */
function resolveConnectEnvVar(d: RuntimeDescriptor, providerRaw: unknown): string | null {
  if (d.id !== 'clawboo-native') return d.envVar
  const provider = typeof providerRaw === 'string' ? providerRaw.trim() : ''
  if (!provider) return d.envVar
  if (provider === 'ollama') return null
  const ev = envVarForProvider(provider)
  if (!ev) return d.envVar
  const allowed = [d.envVar, ...(d.altEnvVars ?? [])].filter((v): v is string => Boolean(v))
  return allowed.includes(ev) ? ev : d.envVar
}

// ─── POST /api/runtimes/clawboo-native/healthcheck ───────────────────────────
// Body: { provider, apiKey }. A single authenticated GET to the provider's
// lightweight models/health endpoint, to verify a pasted key BEFORE seeding a
// team. The key is used for exactly one fetch — NEVER persisted to the vault,
// NEVER logged, NEVER echoed in the response. Wrapped so a network failure /
// bad key resolves to { ok: false, error } instead of throwing into the request.
interface ProviderProbe {
  url: string
  headers: (key: string) => Record<string, string>
}

function ollamaTagsUrl(): string {
  const base = process.env['OLLAMA_BASE_URL']?.trim() || 'http://localhost:11434/v1'
  // Strip a trailing /v1 (the OpenAI-compat path) → the native /api/tags probe.
  return `${base.replace(/\/v1\/?$/, '')}/api/tags`
}

function providerProbe(provider: string): ProviderProbe | null {
  switch (provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
      }
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: (key) => ({ Authorization: `Bearer ${key}` }),
      }
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/models',
        headers: (key) => ({ Authorization: `Bearer ${key}` }),
      }
    case 'ollama':
      return { url: ollamaTagsUrl(), headers: () => ({}) }
    default:
      return null
  }
}

export async function runtimesHealthcheckPOST(req: Request, res: Response): Promise<void> {
  const id = requireRuntimeId(req, res)
  if (!id) return
  if (id !== 'clawboo-native') {
    res
      .status(400)
      .json({ ok: false, error: 'healthcheck is only supported for the native runtime' })
    return
  }
  const body = (req.body ?? {}) as { provider?: unknown; apiKey?: unknown }
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  const probe = providerProbe(provider)
  if (!probe) {
    res.status(400).json({ ok: false, error: `unknown provider '${provider}'` })
    return
  }
  // Ollama is keyless; every other provider needs a key to test.
  if (provider !== 'ollama' && !apiKey) {
    res.status(400).json({ ok: false, error: 'apiKey is required' })
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(probe.url, {
      method: 'GET',
      headers: probe.headers(apiKey),
      signal: controller.signal,
    })
    if (resp.ok) {
      res.json({ ok: true })
      return
    }
    const detail =
      resp.status === 401 || resp.status === 403
        ? 'Invalid API key.'
        : `Provider returned ${resp.status}.`
    res.json({ ok: false, error: detail })
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? `Could not reach ${provider} (timed out).`
        : `Could not reach ${provider}.`
    res.json({ ok: false, error: msg })
  } finally {
    clearTimeout(timer)
  }
}

// ─── POST /api/runtimes/:id/disconnect ───────────────────────────────────────
// Clears the stored credential; keeps the binary + the flag on (card → needs-auth).
export function runtimesDisconnectPOST(req: Request, res: Response): void {
  const id = requireRuntimeId(req, res)
  if (!id) return
  const d = getDescriptor(id)
  if (d.envVar) deleteRuntimeSecret(d.envVar)
  res.json({ ok: true, connectionState: runtimeStatus(id)['connectionState'] })
}

// ─── POST /api/runtimes/:id/run ──────────────────────────────────────────────
// Body: { taskId, assigneeAgentId?, repoPath?, kind?, model?, keepForResume? }
// Drives the task on the runtime end to end (claim → worktree → run → report-up).
export async function runtimesRunPOST(req: Request, res: Response): Promise<void> {
  const idRaw = String(req.params['id'] ?? '')
  if (!isRuntimeId(idRaw)) {
    res.status(404).json({ error: `unknown runtime '${idRaw}'` })
    return
  }
  const id: NonOpenClawRuntimeId = idRaw
  const body = (req.body ?? {}) as Record<string, unknown>
  const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : ''
  if (!taskId) {
    res.status(400).json({ error: 'taskId is required' })
    return
  }
  const assigneeAgentId = typeof body['assigneeAgentId'] === 'string' ? body['assigneeAgentId'] : id
  // The agentId becomes a per-runtime native-home dir segment. Reject any
  // non-identifier value so it can neither escape its dir nor collide two
  // distinct ids into one shared home (defense in depth — sanitizeAgentId is the
  // structural guard; legit native/gateway ids are all [A-Za-z0-9_-]+).
  if (!/^[A-Za-z0-9_-]+$/.test(assigneeAgentId)) {
    res.status(400).json({ error: 'invalid assigneeAgentId' })
    return
  }
  // The runtime's MCP client attaches to THIS server's /api/mcp/* endpoints —
  // a server-trusted loopback URL, never the client-supplied Host header.
  const mcpBaseUrl = loopbackMcpBaseUrl(req)

  // Inject the connected provider key (vault → spawned process env) so a
  // runtime connected from the UI actually authenticates. Codex (oauth, envVar
  // null) gets nothing here — it uses its own CODEX_HOME / `codex login`.
  const d = getDescriptor(id)
  const apiKeyEnv: Record<string, string> = {}
  for (const envVar of [d.envVar, ...(d.altEnvVars ?? [])]) {
    if (!envVar) continue
    const key = resolveRuntimeKey(envVar)
    if (key) apiKeyEnv[envVar] = key
  }

  // Optional per-run circuit-breaker overrides (validated; falls back to the
  // conservative BREAKER_DEFAULTS when absent or invalid).
  const breaker =
    body['breakerConfig'] && typeof body['breakerConfig'] === 'object'
      ? breakerConfigSchema.safeParse(body['breakerConfig'])
      : null

  // Cancel the run (and its subprocess) if the client disconnects before it
  // finishes — a hung CLI otherwise keeps burning with no operator-facing kill.
  const ctl = new AbortController()
  res.on('close', () => ctl.abort())

  try {
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: adapterFactoryFor(id),
      taskId,
      assigneeAgentId,
      repoPath: typeof body['repoPath'] === 'string' ? body['repoPath'] : null,
      kind: typeof body['kind'] === 'string' ? body['kind'] : 'code',
      model: typeof body['model'] === 'string' ? body['model'] : null,
      keepForResume: body['keepForResume'] === true,
      disableMemoryAutoInject: body['disableMemoryAutoInject'] === true,
      ...(typeof body['maxRotations'] === 'number' ? { maxRotations: body['maxRotations'] } : {}),
      ...(breaker?.success ? { breakerConfig: breaker.data } : {}),
      parentTraceparent:
        typeof body['parentTraceparent'] === 'string' ? body['parentTraceparent'] : null,
      mcpBaseUrl,
      abortSignal: ctl.signal,
      ...(Object.keys(apiKeyEnv).length > 0 ? { apiKeyEnv } : {}),
    })
    const status = !result.ok
      ? result.reason === 'conflict'
        ? 409
        : result.reason === 'not_found'
          ? 404
          : 422
      : 200
    res.status(status).json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
