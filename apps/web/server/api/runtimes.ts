// ─── Non-OpenClaw runtimes REST ─────────────────────────
// Thin HTTP layer over the server-side executor runner + the runtime descriptor.
// Lists the available runtimes (capabilities + health + install/auth status),
// installs a runtime CLI (SSE), connects/disconnects its provider key (encrypted
// vault), and runs a board task on one of them.

import { spawn, type ChildProcess } from 'node:child_process'

import type { Request, Response } from 'express'

import { envVarForProvider } from '@clawboo/adapter-native'
import { breakerConfigSchema } from '@clawboo/governance'

import { getDb } from '../lib/db'
import { runTaskOnRuntime } from '../lib/executorRunner'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { fetchOpenRouterModels } from '../lib/openrouterModels'
import {
  findExecutable,
  isWindows,
  resolvePython,
  resolveRuntimeBin,
  resolveShimName,
  type PythonCandidate,
  type PythonRange,
} from '../lib/platform'
import { invalidateCodexAuthCache, isCodexLoggedIn } from '../lib/runtimes/codexAuth'
import {
  getCodexModels,
  invalidateCodexModelsCache,
  peekCodexModels,
} from '../lib/runtimes/codexModels'
import { isHermesCodexAuthPresent } from '../lib/runtimes/hermesAuth'
import { resolveRuntimeInstall, resolveSdkBinary } from '../lib/runtimes/installProbe'
import {
  checkHermesAcp,
  peekHermesAcp,
  resetHermesTransport,
} from '../lib/runtimes/hermesTransport'
import { resolveWindowsSpawn } from '../lib/runtimes/winSpawn'
import { nativeCompatProvider } from '../lib/runtimes/native/nativeProviders'
import { isNativeOllamaConnected } from '../lib/runtimes/native/nativeProviderDefaults'
import {
  ollamaApiBase,
  ollamaModelPulled,
  ollamaPullCommand,
  parseOllamaTags,
} from '../lib/runtimes/native/ollamaModels'
import { adapterFactoryFor, enabledRuntimeIds } from '../lib/runtimes'
import {
  deriveConnectionState,
  disconnectPlanFor,
  getDescriptor,
  isOrchestratableRuntimeId,
  isRuntimeId,
  NON_OPENCLAW_RUNTIME_IDS,
  type NonOpenClawRuntimeId,
  type RuntimeDescriptor,
  runtimeKeySlots,
} from '../lib/runtimes/descriptor'
import {
  deleteRuntimeSecret,
  getRuntimeSecret,
  resolveRuntimeKey,
  resolveRuntimeKeyForRuntime,
  setKeylessProviderChoice,
  setRuntimeDisconnected,
  setRuntimeSecret,
} from '../lib/secretsVault'
import { onEmbeddingKeysChanged } from '../lib/memoryEmbedding'

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

/** Per-runtime install + auth status, WITHOUT exposing any secret value. Pure +
 *  synchronous — the oauth login state (codex) is probed async by the caller and
 *  passed in, so this never blocks the event loop. */
function runtimeStatus(id: NonOpenClawRuntimeId, oauthLoggedIn = false): Record<string, unknown> {
  const d = getDescriptor(id)
  // Built-in runtimes ship inside the server: always installed, no binary.
  // Claude Code is installed by its CLI or by the Agent SDK's own binary.
  const bin = d.builtIn ? null : resolveRuntimeInstall(d)
  const binPath = bin?.path ?? null
  const installed = d.builtIn ? true : Boolean(bin)
  // Presence only — resolveRuntimeKey returns the value but we never expose it.
  // A multi-provider runtime is connected when ANY of its env vars resolves.
  const envVars = [d.envVar, ...(d.altEnvVars ?? [])].filter((v): v is string => Boolean(v))
  // Hermes can ALSO be credentialed by a ChatGPT-subscription login (`hermes
  // login --provider openai-codex`, tokens in ~/.hermes/auth.json — no env var,
  // no vault slot). A presence-only shape check (sync read of a tiny file, the
  // detectAuthProfileKeys precedent; values never leave the helper) folds into
  // hasCredential so a subscription-only hermes reads Connected/ready.
  const hermesCodexAuth = id === 'hermes' && installed ? isHermesCodexAuthPresent() : false
  // Runtime-scoped resolution: an EXPLICITLY disconnected runtime resolves no key,
  // so neither the ambient process-env / OpenClaw-.env fallbacks nor a vault key
  // it shares with another runtime keep the card reading "Connected".
  const hasCredential =
    envVars.some((v) => Boolean(resolveRuntimeKeyForRuntime(id, v))) || hermesCodexAuth
  // Native's keyless provider: a set-up local Ollama readies the runtime with no key
  // at all. It is NOT a credential (`hasCredential` stays "a key resolves"), so it
  // feeds the connection state directly and rides its own native-only flag.
  const ollamaConnected = id === 'clawboo-native' && isNativeOllamaConnected()
  // Vault-only signal: a credential DELIBERATELY connected during onboarding (written
  // to the encrypted vault), as opposed to an ambient `process.env` shell var that
  // `resolveRuntimeKey` ALSO honors. The onboarding native-skip decision reads THIS so
  // a bare exported `ANTHROPIC_API_KEY` doesn't masquerade as "completed onboarding".
  const hasVaultCredential = envVars.some((v) => Boolean(getRuntimeSecret(v)))
  // Codex authenticates via ChatGPT OAuth (`codex login`) — no vault key. The
  // caller detects an existing terminal login (async) and passes it in so clawboo
  // reuses it (shows 'ready') instead of re-prompting. Only meaningful for oauth.
  const loggedIn = d.authKind === 'oauth' && installed && oauthLoggedIn
  return {
    name: d.name,
    installed,
    binPath,
    // Additive: where the binary came from, 'cli' or 'agent-sdk' (null when
    // there is none, and for a built-in runtime).
    binSource: bin?.source ?? null,
    builtIn: d.builtIn,
    authKind: d.authKind,
    envVar: d.envVar,
    hasCredential,
    hasVaultCredential,
    loggedIn,
    // Additive: hermes-only "signed in with ChatGPT" signal (the picker + card
    // gate the subscription model group on it). Always false for other runtimes.
    codexAuth: hermesCodexAuth,
    // Additive: native-only "local Ollama is set up" signal (the providers manager
    // renders its Ollama row from it). Always false for other runtimes.
    ollamaConnected,
    // What a full Disconnect would delete and keep (stored keys only), so its
    // confirm can say exactly that. Env-var names only, never a value.
    disconnectPlan: disconnectPlanFor(id, (v) => Boolean(getRuntimeSecret(v))).plan,
    installCommand: d.installCommand,
    docsUrl: d.docsUrl,
    connectionState: deriveConnectionState(
      d,
      installed,
      hasCredential || ollamaConnected,
      loggedIn,
    ),
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
        // Probe the codex login state async (off the event-loop hot path).
        const oauthLoggedIn = id === 'codex' ? await isCodexLoggedIn() : false
        // A signed-in Codex CLI too old for the plan's current models fails every
        // run. Read from the cached model probe, never awaited: the first request
        // starts it and a later one reports it.
        const codexModels = id === 'codex' && oauthLoggedIn ? peekCodexModels() : null
        // A Hermes installed without its ACP mode runs, but on the quiet path.
        // Asked of Hermes and cached, never awaited, like the Codex read above.
        const hermesAcp = id === 'hermes' && resolveRuntimeBin('hermes') ? peekHermesAcp() : null
        return {
          id,
          participantKind: adapter.participantKind,
          capabilities: adapter.capabilities(),
          health: await adapter.health(),
          ...runtimeStatus(id, oauthLoggedIn),
          ...(codexModels
            ? { updateRequired: codexModels.updateRequired, cliVersion: codexModels.cliVersion }
            : {}),
          ...(hermesAcp !== null ? { acpMissing: !hermesAcp } : {}),
        }
      }),
    )
    const available = NON_OPENCLAW_RUNTIME_IDS.map((id) => publicDescriptor(getDescriptor(id)))
    res.json({ runtimes, available })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}

/** The latest install of each runtime, read by the one-at-a-time guard. */
const installs = new Map<NonOpenClawRuntimeId, { child: ChildProcess | null }>()

/** An install's process has not exited yet. */
function installRunning(ctl: { child: ChildProcess | null } | undefined): boolean {
  const child = ctl?.child
  return child != null && child.exitCode === null && child.signalCode === null
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

  // One install per runtime at a time: an update outlives its client (below), so
  // a second request could otherwise run over it.
  if (installRunning(installs.get(id))) {
    sendEvent(res, {
      type: 'error',
      code: 'INSTALL_RUNNING',
      message: `${d.name} is already being installed. Wait for it to finish, then Re-check.`,
    })
    res.end()
    return
  }

  // Runs use the Agent SDK's own binary, so with it present a CLI install would
  // fetch a second copy that no run starts. Checked directly: a CLI on PATH as
  // well would otherwise win the install probe and hide it.
  const sdkBinary = resolveSdkBinary(d)
  if (sdkBinary) {
    sendEvent(res, {
      type: 'output',
      line: `${d.name} already runs on the Agent SDK's own binary: ${sdkBinary}`,
    })
    sendEvent(res, { type: 'complete', success: true })
    res.end()
    return
  }

  sendEvent(res, { type: 'progress', step: 'installing', message: `Installing ${d.name}…` })

  // An install over one that is already there is an update. Stopped part way it
  // can leave the runtime half replaced (`pipx install --force` reinstalls into
  // the same environment), so it runs to the end when its client goes away (a
  // closed panel, a reloaded tab). A first install has nothing to break, so it
  // still stops with its client. The handler covers whichever child is active
  // (the pip path may spawn a second one for the PEP-668 retry).
  const updating = Boolean(d.healthBin && resolveRuntimeBin(d.healthBin))
  const ctl: { child: ChildProcess | null } = { child: null }
  installs.set(id, ctl)
  res.on('close', () => {
    if (!updating && ctl.child && !ctl.child.killed) ctl.child.kill()
  })

  if (d.packageManager === 'npm') installViaNpm(res, d, ctl)
  else installViaPip(res, d, ctl)
}

/** On a successful install: flip the flag on (live; runtime flags need no
 *  restart), then report binary presence. */
async function finishInstall(res: Response, d: RuntimeDescriptor): Promise<void> {
  // A new Codex CLI can read models the old one could not.
  if (d.id === 'codex') invalidateCodexModelsCache()
  // A reinstalled Hermes may have gained its ACP mode. Ask it again before
  // reporting done, so the status read that follows already has the answer.
  if (d.id === 'hermes') {
    resetHermesTransport()
    await checkHermesAcp()
  }
  // No cache to bust — resolveRuntimeBin probes PATH + user-install dirs live
  // (it's what finds Hermes in the Python user-site bin off PATH).
  if (resolveRuntimeInstall(d)) {
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
    if (code === 0) void finishInstall(res, d)
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

/** "3.11 to 3.13", "3.11 or newer", or "3" for a package with no range. */
function pythonRangeLabel(range: PythonRange): string {
  const hasMax = Number.isFinite(range.maxMinor)
  if (range.minMinor > 0 && hasMax) {
    return range.minMinor === range.maxMinor
      ? `3.${range.minMinor}`
      : `3.${range.minMinor} to 3.${range.maxMinor}`
  }
  if (range.minMinor > 0) return `3.${range.minMinor} or newer`
  if (hasMax) return `3.${range.maxMinor} or older`
  return '3'
}

/** The install error when no Python inside the package's range was found. It
 *  names the range and every Python that WAS found, so a 3.14 reads as outside
 *  the range instead of as missing or too old. */
function pythonUnavailableEvent(
  d: RuntimeDescriptor,
  range: PythonRange,
  found: PythonCandidate[],
): Record<string, unknown> {
  const label = pythonRangeLabel(range)
  // The install hint names the top of the range (the bottom when it has no top).
  const top = Number.isFinite(range.maxMinor)
    ? range.maxMinor
    : range.minMinor > 0
      ? range.minMinor
      : null
  const hint =
    top !== null
      ? `Install Python 3.${top} (for example \`brew install python@3.${top}\`), then Retry.`
      : 'Install Python 3, then Retry.'
  if (found.length === 0) {
    return {
      type: 'error',
      code: 'PYTHON_MISSING',
      message: `Python ${label} (with pip or pipx) not found. ${hint}`,
    }
  }
  const versions = [
    ...new Set(
      found.map(
        (c) =>
          `${c.version}${/Xcode\.app|CommandLineTools/i.test(c.bin) ? ' (Xcode Command Line Tools)' : ''}`,
      ),
    ),
  ]
  const list =
    versions.length > 1
      ? `${versions.slice(0, -1).join(', ')} and ${versions[versions.length - 1]}`
      : versions[0]
  return {
    type: 'error',
    code: found.every((c) => c.minor < range.minMinor) ? 'PYTHON_TOO_OLD' : 'PYTHON_UNSUPPORTED',
    message: `${d.name} needs Python ${label}, but Clawboo found only Python ${list}. ${hint}`,
  }
}

function installViaPip(
  res: Response,
  d: RuntimeDescriptor,
  ctl: { child: ChildProcess | null },
): void {
  // Resolve the newest interpreter INSIDE the package's range (Hermes: 3.11 to
  // 3.13). The newest overall is not enough: a 3.14 would beat an installed 3.12
  // and pip would then find no release for it.
  const range: PythonRange = {
    minMinor: d.pythonMinMinor ?? 0,
    maxMinor: d.pythonMaxMinor ?? Number.POSITIVE_INFINITY,
  }
  const { compatible, found } = resolvePython(range)

  // Prefer pipx (sidesteps PEP-668 entirely); pin its interpreter to the
  // in-range one so it never builds the venv with an out-of-range default Python.
  // With no in-range interpreter found, pipx runs on its own default Python,
  // which may be one this probe could not see.
  const pipx = resolveRuntimeBin('pipx') ?? findExecutable('pipx')
  if (pipx) {
    sendEvent(res, { type: 'progress', step: 'installing', message: 'Installing via pipx…' })
    // `--force` reinstalls over an existing install, which is how Update adds a
    // missing extra; without it pipx leaves an installed package as it is.
    const args = [
      'install',
      '--force',
      ...(compatible ? ['--python', compatible.bin] : []),
      d.pkg ?? '',
    ]
    try {
      ctl.child = spawn(pipx, args, {
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

  // No pipx → `python -m pip install --user` with an in-range interpreter,
  // retrying once with --break-system-packages for PEP-668 environments.
  if (!compatible) {
    sendEvent(res, pythonUnavailableEvent(d, range, found))
    res.end()
    return
  }
  runPipUser(res, d, ctl, compatible.bin, false)
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
  // `--upgrade` moves an existing install to the newest release in range, which is
  // how Update reaches one that has the extras asked for.
  const args = [
    '-m',
    'pip',
    'install',
    '--upgrade',
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
      void finishInstall(res, d)
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
export async function runtimesConnectPOST(req: Request, res: Response): Promise<void> {
  const id = requireRuntimeId(req, res)
  if (!id) return
  const d = getDescriptor(id)

  if (d.authKind === 'oauth') {
    // Codex can't be connected with a pasted key — the user runs `codex login` in
    // their terminal. Report the CURRENT state: 'ready' when we detect an existing
    // login (reuse it), else 'needs-login' with the command to run.
    const loggedIn = id === 'codex' ? await isCodexLoggedIn() : false
    setRuntimeDisconnected(id, false)
    res.json({
      ok: true,
      connectionState: runtimeStatus(id, loggedIn)['connectionState'],
      loginCommand: `${d.healthBin ?? d.id} login`,
    })
    return
  }

  if (d.authKind === 'none' || !d.envVar) {
    setRuntimeDisconnected(id, false)
    res.json({ ok: true, connectionState: runtimeStatus(id)['connectionState'] })
    return
  }

  const body = (req.body ?? {}) as { apiKey?: unknown; provider?: unknown }

  // The native runtime is multi-provider: a pasted key must land in the vault
  // slot for the CHOSEN provider (OpenAI/OpenRouter keys would otherwise be
  // written to ANTHROPIC_API_KEY). `null` = a keyless provider (Ollama): there is
  // no key to store, so the CHOICE is what gets recorded, and that alone readies
  // the runtime (served at OLLAMA_BASE_URL, else the local default).
  const targetEnvVar = resolveConnectEnvVar(d, body.provider)
  if (targetEnvVar === undefined) {
    res.status(400).json({ error: `unknown provider '${String(body.provider).trim()}'` })
    return
  }
  if (targetEnvVar === null) {
    setKeylessProviderChoice('ollama', true)
    setRuntimeDisconnected(id, false)
    res.json({ ok: true, connectionState: runtimeStatus(id)['connectionState'] })
    return
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey) {
    // Keyless REUSE (native + explicit provider, no key pasted): reconnect using a
    // key that ALREADY exists for that provider — the Providers hub's vault slot or
    // OpenClaw's .env. Deliberately the UNSCOPED resolve chain: the explicit-
    // disconnect override is exactly what this request is lifting, so ambient
    // stores must count. Nothing is stored and the key is never echoed.
    const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
    if (d.id === 'clawboo-native' && provider && resolveRuntimeKey(targetEnvVar)) {
      setRuntimeDisconnected(id, false)
      res.json({ ok: true, connectionState: runtimeStatus(id)['connectionState'] })
      return
    }
    // The same reuse for a single-provider runtime (Claude Code, Hermes): its
    // disconnect keeps a key another runtime still reads, so connecting it again
    // can use that key instead of asking for a re-paste. A `provider` here names
    // a key this runtime cannot be told to use, so it gets the 400 below rather
    // than a success on whichever other key happens to resolve.
    if (
      d.id !== 'clawboo-native' &&
      !provider &&
      runtimeKeySlots(d).some((v) => resolveRuntimeKey(v))
    ) {
      setRuntimeDisconnected(id, false)
      res.json({ ok: true, connectionState: runtimeStatus(id)['connectionState'] })
      return
    }
    res.status(400).json({
      error: provider
        ? `no existing key found for ${provider} — paste one to connect`
        : 'apiKey is required',
    })
    return
  }
  setRuntimeSecret(targetEnvVar, apiKey)
  // A new key may change which provider embeds memory.
  onEmbeddingKeysChanged()
  // A reconnect lifts the explicit-disconnect override — ambient key reuse
  // (process env / OpenClaw's .env) applies again for this runtime.
  setRuntimeDisconnected(id, false)
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
 *  `null` means a keyless provider (Ollama) with nothing to store, and
 *  `undefined` a provider the native runtime cannot drive. That one is refused:
 *  storing its key under another provider's name would hand, say, a MiniMax key
 *  to Anthropic. */
function resolveConnectEnvVar(
  d: RuntimeDescriptor,
  providerRaw: unknown,
): string | null | undefined {
  if (d.id !== 'clawboo-native') return d.envVar
  const provider = typeof providerRaw === 'string' ? providerRaw.trim() : ''
  if (!provider) return d.envVar
  if (provider === 'ollama') return null
  const ev = envVarForProvider(provider)
  const allowed = [d.envVar, ...(d.altEnvVars ?? [])].filter((v): v is string => Boolean(v))
  return ev && allowed.includes(ev) ? ev : undefined
}

// ─── POST /api/runtimes/clawboo-native/healthcheck ───────────────────────────
// Body: { provider, apiKey?, model? }. A single authenticated GET to the provider's
// lightweight models/health endpoint, to verify a credential BEFORE anything
// commits to it. `apiKey` is optional: omit it to probe the key already stored
// for that provider (what the one-click reuse surfaces do), pass one to probe a
// key the user just typed. Either way it is used for exactly one fetch — NEVER
// persisted to the vault, NEVER logged, NEVER echoed in the response. Wrapped so
// a network failure / bad key resolves to { ok: false, error } instead of
// throwing into the request. The route probes a PROVIDER, not a runtime, so any
// surface holding a provider key can use it to check that key. For keyless
// Ollama, `model` is also checked against the pulled list; a missing one comes
// back as { ok: false, error, missingModel }.
interface ProviderProbe {
  url: string
  headers: (key: string) => Record<string, string>
}

function ollamaTagsUrl(): string {
  return `${ollamaApiBase()}/api/tags`
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
    default: {
      // Extra OpenAI-compatible providers probe their own `/models` endpoint.
      const ep = nativeCompatProvider(provider)
      if (ep)
        return {
          url: `${ep.baseURL}/models`,
          headers: (key) => ({ Authorization: `Bearer ${key}` }),
        }
      return null
    }
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
  const body = (req.body ?? {}) as { provider?: unknown; apiKey?: unknown; model?: unknown }
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  // Ollama only: the model the user is about to run. A daemon that answers but
  // never pulled it fails every run, so that is a failed check too.
  const model = provider === 'ollama' && typeof body.model === 'string' ? body.model.trim() : ''
  const probe = providerProbe(provider)
  if (!probe) {
    res.status(400).json({ ok: false, error: `unknown provider '${provider}'` })
    return
  }
  // Ollama is keyless. Every other provider needs a key — but not necessarily a
  // PASTED one: with no `apiKey` in the body, fall back to the key already stored
  // for that provider, so a surface that reconnects WITHOUT a re-paste (the
  // Providers manager's one-click "Use") can verify it first. Deliberately the
  // same unscoped resolve chain the connect route's keyless-REUSE branch uses.
  // The resolved key is used for the one probe fetch below and, exactly like a
  // pasted one, is never re-persisted, never logged, and never echoed back.
  let probeKey = apiKey
  if (provider !== 'ollama' && !probeKey) {
    const envVar = envVarForProvider(provider)
    probeKey = (envVar && resolveRuntimeKey(envVar)) || ''
    if (!probeKey) {
      res.status(400).json({ ok: false, error: 'apiKey is required' })
      return
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(probe.url, {
      method: 'GET',
      headers: probe.headers(probeKey),
      // Fail CLOSED on a redirect rather than following one. Every probe URL
      // above is a hard-coded provider endpoint that never legitimately 3xxes,
      // and the request carries a live credential: `fetch` only strips
      // `Authorization` across origins, so Anthropic's custom `x-api-key` would
      // ride a redirect to whatever host answered. A 3xx here means something is
      // wrong, and reporting "couldn't reach" beats leaking the key to find out.
      redirect: 'error',
      signal: controller.signal,
    })
    if (resp.ok) {
      // A body that isn't a tags list proves nothing either way, so only a real
      // list can report the model missing.
      const pulled = model ? parseOllamaTags(await resp.json().catch(() => null)) : null
      if (pulled && !ollamaModelPulled(pulled, model)) {
        res.json({
          ok: false,
          error: `Ollama is running, but it doesn't have ${model} yet. Pull it with "${ollamaPullCommand(model)}".`,
          missingModel: model,
        })
        return
      }
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
// Stops the runtime using any key; keeps the binary (card → needs-auth). TWO
// parts:
//  • Delete the vault slots ONLY this runtime reads (envVar + altEnvVars). The
//    vault holds ONE copy of each provider key for every runtime, so a slot
//    another runtime also reads stays in place for it (disconnecting Hermes used
//    to delete the Anthropic and OpenAI keys Clawboo Native and Claude Code run
//    on). `disconnectPlanFor` decides; the status route shows the same plan so
//    the confirm names exactly what goes and what stays.
//  • Record the per-runtime disconnect override. While set, this runtime
//    resolves NO key: not an ambient one (a shell-exported var, OpenClaw's
//    ~/.openclaw/.env) and not a kept shared one. The next connect of THIS
//    runtime clears it. For native it also records local Ollama as REMOVED, so
//    disconnect means the same for every provider: Ollama agents stop, and a later
//    key connect or an ambient OLLAMA_BASE_URL can't turn it back on. Only picking
//    Ollama again does.
// Body `{ provider: 'ollama' }` (native only) is the provider-scoped form: it
// removes ONLY the local-Ollama choice and leaves every key alone (a keyed
// provider's own disconnect is `POST /api/providers/:id/disconnect`).
export function runtimesDisconnectPOST(req: Request, res: Response): void {
  const id = requireRuntimeId(req, res)
  if (!id) return
  const body = (req.body ?? {}) as { provider?: unknown }
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  // A provider that is sent but unreadable must not fall through to the full
  // disconnect below, which deletes the keys only this runtime reads.
  if (body.provider !== undefined && !provider) {
    res.status(400).json({ error: 'provider must be a non-empty string' })
    return
  }
  if (provider) {
    if (id !== 'clawboo-native' || provider !== 'ollama') {
      res.status(400).json({
        error: `only the native runtime's keyless 'ollama' disconnects by provider here; remove a provider key via /api/providers/:id/disconnect`,
      })
      return
    }
    // Recorded as REMOVED (not just forgotten) so an ambient OLLAMA_BASE_URL
    // can't silently keep Ollama connected after the user removed it.
    setKeylessProviderChoice('ollama', false)
    res.json({ ok: true, connectionState: runtimeStatus(id)['connectionState'] })
    return
  }
  const { deletes, plan } = disconnectPlanFor(id, (v) => Boolean(getRuntimeSecret(v)))
  for (const envVar of deletes) deleteRuntimeSecret(envVar)
  if (id === 'clawboo-native') setKeylessProviderChoice('ollama', false)
  setRuntimeDisconnected(id, true)
  // Stop embedding memory with a key the user just removed.
  onEmbeddingKeysChanged({ removed: deletes })
  res.json({
    ok: true,
    connectionState: runtimeStatus(id)['connectionState'],
    removed: plan.removes,
    kept: plan.keeps,
  })
}

// ─── POST /api/runtimes/:id/logout ───────────────────────────────────────────
// Sign out an OAUTH runtime (Codex): runs the CLI's OWN `logout` (posture: the
// official CLI removes its own tokens; clawboo never touches them directly).
// Signs out the ChatGPT subscription EVERY tool shares (the UI warns). 404 for a
// non-oauth runtime (api-key runtimes use /disconnect). Truth = the re-probe.
export async function runtimesLogoutPOST(req: Request, res: Response): Promise<void> {
  const id = requireRuntimeId(req, res)
  if (!id) return
  const d = getDescriptor(id)
  if (d.authKind !== 'oauth') {
    res.status(404).json({ error: `runtime '${id}' has no sign-out` })
    return
  }
  const bin = resolveRuntimeBin(d.healthBin ?? id)
  if (!bin) {
    res.status(400).json({ error: `${d.name} is not installed` })
    return
  }
  // Best-effort spawn (safe on Windows shims via resolveWindowsSpawn); the
  // re-probe below is the source of truth, so a spawn failure just leaves the
  // reported state unchanged.
  try {
    await new Promise<void>((resolve) => {
      const plan = resolveWindowsSpawn({ command: bin, args: ['logout'] })
      const child = spawn(plan.command, plan.args, {
        stdio: 'ignore',
        windowsHide: isWindows,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
    })
  } catch {
    /* re-probe is the truth */
  }
  invalidateCodexAuthCache()
  invalidateCodexModelsCache()
  const loggedIn = await isCodexLoggedIn()
  res.json({ ok: !loggedIn, connectionState: runtimeStatus(id, loggedIn)['connectionState'] })
}

// ─── POST /api/runtimes/:id/run ──────────────────────────────────────────────
// Body: { taskId, assigneeAgentId?, repoPath?, kind?, model?, keepForResume? }
// Drives the task on the runtime end to end (claim → worktree → run → report-up).
export async function runtimesRunPOST(req: Request, res: Response): Promise<void> {
  const idRaw = String(req.params['id'] ?? '')
  // The orchestration check, not the static list: with its flag on, the mock
  // runtime is a runtime this route can drive.
  if (!isOrchestratableRuntimeId(idRaw)) {
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
    const key = resolveRuntimeKeyForRuntime(id, envVar)
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
      db: getDb(),
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

// ─── GET /api/runtimes/openrouter/models ─────────────────────────────────────
// The live OpenRouter model catalog (public list endpoint, no key needed).
// Cached in-process; never throws — an empty list tells the client to fall back
// to its small hardcoded set. Powers the native OpenRouter model pickers.
export async function runtimesOpenRouterModelsGET(_req: Request, res: Response): Promise<void> {
  const models = (await fetchOpenRouterModels()) ?? []
  res.json({ models })
}

// ─── GET /api/runtimes/codex/models ──────────────────────────────────────────
// The models the user's ChatGPT subscription can run, read from their own Codex
// CLI (`codex app-server` → `model/list`, else the CLI's on-disk cache). Cached
// in-process; never throws. Empty `models` means unknown: the pickers then offer
// only the plan default, which each CLI resolves for itself.
export async function runtimesCodexModelsGET(_req: Request, res: Response): Promise<void> {
  const { models, defaultModel, updateRequired, cliVersion } = await getCodexModels()
  res.json({ models, defaultModel, updateRequired, cliVersion })
}
