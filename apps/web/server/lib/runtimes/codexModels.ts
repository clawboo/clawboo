// The models a ChatGPT subscription can run, read from the user's own Codex CLI.
//
// The backend decides which models a ChatGPT account may use, and that list moves:
// ids clawboo once hardcoded (gpt-5.5, gpt-5.4, gpt-5.3-codex) are now refused with
// "The '<model>' model is not supported when using Codex with a ChatGPT account".
// So nothing here names a model. The list comes from, in order:
//   1. `codex app-server` → `model/list`, run in the user's own CODEX_HOME. The CLI
//      refreshes the account's list from the backend with its own login, in its own
//      home; clawboo never reads a token.
//   2. `$CODEX_HOME/models_cache.json`, the last list a Codex CLI on this machine
//      fetched for the account (ChatGPT.app's bundled CLI keeps it current).
//
// An OLD CLI cannot decode the backend's current list (0.136: "failed to decode models
// response: unknown variant `max`") and silently answers `model/list` with the catalog
// it shipped with, whose ids the backend refuses. That answer is never trusted: it is
// reported as `updateRequired`, and the cache (if any) is used instead.

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { isWindows, resolveRuntimeBin } from '../platform'
import { buildChildEnv } from './childEnv'
import { isCodexLoggedIn, userCodexHome } from './codexAuth'
import { killProcessTree } from './killTree'
import { registerRuntimeChild, unregisterRuntimeChild } from './subprocess'
import { resolveWindowsSpawn } from './winSpawn'

export interface CodexModelOption {
  /** The bare backend id (`gpt-5.6-luna`), as `--model` / `-m` take it. */
  id: string
  label: string
}

export interface CodexModelList {
  /** The account's models in the CLI's own order (most capable first). */
  models: CodexModelOption[]
  /** The model the CLI runs when none is pinned, or null when unknown. */
  defaultModel: string | null
  /** Where the list came from; null when neither source had one. */
  source: 'cli' | 'cache' | null
  /** The installed Codex CLI could not read the account's current models, so its
   *  runs fail until it is updated. */
  updateRequired: boolean
  /** The installed CLI's version, when the probe reached it. */
  cliVersion: string | null
}

const EMPTY: CodexModelList = {
  models: [],
  defaultModel: null,
  source: null,
  updateRequired: false,
  cliVersion: null,
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** One `model/list` page (`{ data: Model[] }`) → its visible options + the model it
 *  marks `isDefault` (null when this page marks none). */
export function parseAppServerModels(result: unknown): {
  models: CodexModelOption[]
  defaultModel: string | null
} {
  const data = asRecord(result)?.['data']
  const models: CodexModelOption[] = []
  let defaultModel: string | null = null
  for (const raw of Array.isArray(data) ? data : []) {
    const m = asRecord(raw)
    const id = asStr(m?.['model']) ?? asStr(m?.['id'])
    if (!m || !id || m['hidden'] === true) continue
    if (models.some((x) => x.id === id)) continue
    models.push({ id, label: asStr(m['displayName']) ?? id })
    if (m['isDefault'] === true && !defaultModel) defaultModel = id
  }
  return { models, defaultModel }
}

/** `models_cache.json` → visible options ordered by the backend's priority. The CLI
 *  marks no default in the cache; its default is the first by priority. */
export function parseModelsCache(raw: unknown): {
  models: CodexModelOption[]
  defaultModel: string | null
} {
  const entries = asRecord(raw)?.['models']
  const ranked: { rank: number; id: string; label: string }[] = []
  for (const e of Array.isArray(entries) ? entries : []) {
    const m = asRecord(e)
    const id = asStr(m?.['slug'])
    if (!m || !id) continue
    const visibility = asStr(m['visibility'])?.toLowerCase()
    if (visibility === 'hide' || visibility === 'hidden') continue
    if (ranked.some((x) => x.id === id)) continue
    const priority = m['priority']
    ranked.push({
      rank: typeof priority === 'number' ? priority : Number.MAX_SAFE_INTEGER,
      id,
      label: asStr(m['display_name']) ?? id,
    })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
  const models = ranked.map(({ id, label }) => ({ id, label }))
  return { models, defaultModel: models[0]?.id ?? null }
}

/** The CLI version from the `initialize` result's userAgent
 *  (`clawboo/0.158.0 (Mac OS 26.3.1; arm64) …`). */
export function parseUserAgentVersion(userAgent: unknown): string | null {
  const ua = asStr(userAgent)
  return ua ? (/^[^/\s]+\/(\S+)/.exec(ua)?.[1] ?? null) : null
}

/** What one `codex app-server` probe saw. */
export interface AppServerProbe {
  models: CodexModelOption[]
  defaultModel: string | null
  version: string | null
  /** The CLI could not refresh the account's list (offline, or too old to read it),
   *  so `models` is the catalog it shipped with. */
  refreshFailed: boolean
  /** The CLI fetched the account's list but could not decode it: too old. */
  decodeFailed: boolean
}

/** Read the CLI's own stderr log for the two refresh failures that matter. */
export function classifyProbeStderr(stderr: string): {
  refreshFailed: boolean
  decodeFailed: boolean
} {
  return {
    refreshFailed: /failed to refresh available models/i.test(stderr),
    decodeFailed: /failed to decode models response/i.test(stderr),
  }
}

/** Pick the list to trust from a probe and the on-disk cache. Pure. */
export function combineCodexModelSources(
  probe: AppServerProbe | null,
  cache: { models: CodexModelOption[]; defaultModel: string | null } | null,
): CodexModelList {
  const updateRequired = probe?.decodeFailed === true
  const cliVersion = probe?.version ?? null
  const from = (
    src: { models: CodexModelOption[]; defaultModel: string | null },
    source: 'cli' | 'cache',
  ): CodexModelList => ({
    models: src.models,
    defaultModel: src.defaultModel,
    source,
    updateRequired,
    cliVersion,
  })
  // A refreshed CLI answer is the account's live list.
  if (probe && !probe.refreshFailed && probe.models.length > 0) return from(probe, 'cli')
  // Otherwise the last list a CLI fetched beats a shipped catalog.
  if (cache && cache.models.length > 0) return from(cache, 'cache')
  // An offline CLI that CAN read the current format ships a usable catalog; an old
  // one's catalog is exactly the refused ids, so it is never offered.
  if (probe && !probe.decodeFailed && probe.models.length > 0) return from(probe, 'cli')
  return { ...EMPTY, updateRequired, cliVersion }
}

const PROBE_TIMEOUT_MS = 20_000
const STDERR_SETTLE_MS = 150
const MAX_STDERR = 64 * 1024
const MAX_PAGES = 10

/**
 * Run `codex app-server`, `initialize`, then page through `model/list`. Resolves
 * null when the CLI cannot be spawned, times out, or answers with an error. The
 * child is always reaped. `spawnPlan` is the seam the tests drive a fake server
 * through.
 */
export function probeCodexAppServer(
  spawnPlan: { command: string; args: string[] },
  env: NodeJS.ProcessEnv,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<AppServerProbe | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      const plan = resolveWindowsSpawn(spawnPlan)
      child = spawn(plan.command, plan.args, {
        env,
        shell: false,
        windowsHide: isWindows,
        // A process-group leader, so the reap below takes any grandchildren too.
        detached: !isWindows,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      resolve(null)
      return
    }
    // Joins the runtime children shutdown reaps, so a probe never outlives the server.
    registerRuntimeChild(child)

    let settled = false
    let stdout = ''
    let stderr = ''
    let version: string | null = null
    let requestId = 0
    let pages = 0
    const models: CodexModelOption[] = []
    let defaultModel: string | null = null

    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref()
    const finish = (value: AppServerProbe | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killProcessTree(child)
      resolve(value)
    }

    const send = (msg: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`)
      } catch {
        finish(null)
      }
    }
    const requestPage = (cursor: string | null): void => {
      requestId += 1
      send({
        id: requestId,
        method: 'model/list',
        params: { includeHidden: false, ...(cursor ? { cursor } : {}) },
      })
    }

    const onMessage = (msg: Record<string, unknown>): void => {
      if (msg['id'] === 0) {
        if (msg['error']) return finish(null)
        version = parseUserAgentVersion(asRecord(msg['result'])?.['userAgent'])
        send({ method: 'initialized' })
        return requestPage(null)
      }
      if (requestId === 0 || msg['id'] !== requestId) return // a notification
      if (msg['error']) return finish(null)
      const result = asRecord(msg['result'])
      const page = parseAppServerModels(result)
      for (const m of page.models) if (!models.some((x) => x.id === m.id)) models.push(m)
      defaultModel ??= page.defaultModel
      pages += 1
      const cursor = asStr(result?.['nextCursor'])
      if (cursor && pages < MAX_PAGES) return requestPage(cursor)
      // The CLI logs a failed refresh before it answers, but stderr and stdout are
      // separate pipes: give a log line already written a moment to arrive.
      setTimeout(
        () =>
          finish({
            models,
            defaultModel: defaultModel ?? models[0]?.id ?? null,
            version,
            ...classifyProbeStderr(stderr),
          }),
        STDERR_SETTLE_MS,
      )
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      let nl: number
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim()
        stdout = stdout.slice(nl + 1)
        if (!line) continue
        try {
          const msg = asRecord(JSON.parse(line))
          if (msg) onMessage(msg)
        } catch {
          /* not a JSON-RPC line */
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8')
    })
    // A CLI that exits early turns the next write into EPIPE on stdin.
    child.stdin?.on('error', () => finish(null))
    child.on('error', () => finish(null))
    child.on('close', () => {
      unregisterRuntimeChild(child)
      finish(null)
    })

    send({
      id: 0,
      method: 'initialize',
      params: {
        clientInfo: { name: 'clawboo', title: 'Clawboo', version: '0' },
        capabilities: null,
      },
    })
  })
}

/** The on-disk list a Codex CLI last fetched for this account, or null. */
export async function readCodexModelsCache(
  codexHome: string,
): Promise<{ models: CodexModelOption[]; defaultModel: string | null } | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(codexHome, 'models_cache.json'), 'utf8'))
    const parsed = parseModelsCache(raw)
    return parsed.models.length > 0 ? parsed : null
  } catch {
    return null
  }
}

/** Probe the installed CLI (only when it is signed in: an anonymous `model/list`
 *  is the shipped catalog) and read the cache, then pick what to trust. */
async function loadCodexModels(): Promise<CodexModelList> {
  const codexHome = userCodexHome()
  const bin = resolveRuntimeBin('codex')
  const probe =
    bin && (await isCodexLoggedIn())
      ? await probeCodexAppServer(
          { command: bin, args: ['app-server'] },
          // The user's own home: the CLI keeps its login and its list there.
          // RUST_LOG pins the error-level log the refresh classification reads.
          buildChildEnv({ CODEX_HOME: codexHome, RUST_LOG: 'error' }),
        )
      : null
  return combineCodexModelSources(probe, await readCodexModelsCache(codexHome))
}

const TTL_MS = 10 * 60 * 1000
const EMPTY_TTL_MS = 60 * 1000

let cached: { at: number; value: CodexModelList } | null = null
let inflight: Promise<CodexModelList> | null = null

function isFresh(entry: { at: number; value: CodexModelList }): boolean {
  const ttl = entry.value.models.length > 0 ? TTL_MS : EMPTY_TTL_MS
  return Date.now() - entry.at < ttl
}

/** The subscription's model list, cached in-process. Never throws. */
export function getCodexModels(): Promise<CodexModelList> {
  if (cached && isFresh(cached)) return Promise.resolve(cached.value)
  if (inflight) return inflight
  inflight = loadCodexModels()
    .catch(() => EMPTY)
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** The cached list without waiting (null when none yet); starts a refresh when the
 *  copy is missing or stale. For request paths that must not block on a spawn. */
export function peekCodexModels(): CodexModelList | null {
  if (!cached || !isFresh(cached)) void getCodexModels()
  return cached?.value ?? null
}

/** Forget the cached list (after an install or a sign-in changes the answer). */
export function invalidateCodexModelsCache(): void {
  cached = null
}

/** The `openai-codex/<model>` ref for the subscription's default model, or null
 *  when the account's list is unknown. */
export async function codexSubscriptionModelRef(): Promise<string | null> {
  const { defaultModel } = await getCodexModels()
  return defaultModel ? `openai-codex/${defaultModel}` : null
}
