// ─── The embedding provider every memory surface shares ─────────────────────
// One cache for the REST routes, the MCP HTTP server, the native in-process
// bridge and run-start memory injection, so starting Ollama, pulling its
// embedding model or connecting a key takes effect everywhere without a
// restart.
//
// What happens here, and nowhere else:
//   - re-probing, on a long TTL while a local provider serves and a short one
//     otherwise (so a returning Ollama is noticed while OpenAI stands in),
//     driven by a server timer so it does not depend on anyone having Memory
//     open, and straight after an embedding call fails;
//   - retiring a remote provider the moment it stops being the chosen one, so
//     anything that captured it cannot keep sending fact text with a key the
//     user has just disconnected (a local provider sends nothing off the
//     machine, so it survives an Ollama restart);
//   - keeping embeddings local once the store has had local vectors
//     (storeIsLocalFirst), with the user's choice of OpenAI lasting only until
//     Ollama is found serving again, or the key it was made with is gone;
//   - indexing facts saved without a vector, whenever a usable provider
//     appears or changes.

import {
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_URL,
  REEMBED_REQUEST_SETTING,
  REMOTE_EMBEDDING_CONSENT_SETTING,
  SqliteMemoryStore,
  embeddingsDisabled,
  getSetting,
  isRemoteEmbeddingProvider,
  isRequestShapedEmbeddingError,
  noteEmbeddingProviderServing,
  probeEmbeddingProvider,
  setSetting,
  storeIsLocalFirst,
  type BackfillEmbeddingsResult,
  type EmbeddingProvider,
  type EmbeddingResolution,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { getDb } from './db'
import { getRuntimeSecret, hasRuntimeSecret, isVaultReadable } from './secretsVault'

const log = createLogger('memory-embedding')

/** A local provider is re-checked this often, so a stopped Ollama is noticed
 *  even when no embedding call fails. */
const READY_TTL_MS = 10 * 60_000
/** Anything else (nothing usable, or OpenAI standing in) is re-checked this
 *  often, so starting Ollama, pulling the model or adding a key takes effect
 *  without a restart. A probe is one local request; it never calls OpenAI. */
const UNUSABLE_TTL_MS = 30_000
/** After a failed backfill pass, automatic retries wait this long. */
const RETRY_AFTER_FAILURE_MS = 60_000
/** The server timer: re-probe when stale on every tick, heal every few. */
const TICK_MS = 30_000
const HEAL_EVERY_TICKS = 10

export const REMOTE_CONSENT_SETTING = REMOTE_EMBEDDING_CONSENT_SETTING

/** What Retry sends to check a provider's health. Never fact text. */
const HEALTH_CHECK_TEXT = 'clawboo embedding check'

/** A provider that has been replaced. Throwing (rather than calling out) is what
 *  makes disconnecting a key take effect for anything that captured it. */
export class EmbeddingProviderRetiredError extends Error {
  constructor(id: string) {
    super(`embedding provider ${id} is no longer in use`)
    this.name = 'EmbeddingProviderRetiredError'
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

interface Resolved {
  res: EmbeddingResolution
  /** Distinguishes two OpenAI providers with the same id but different keys. */
  fingerprint: string | null
  /** An OpenAI key exists that local-first is holding back. */
  remoteAvailable: boolean
  /** Whether any OpenAI key was found. With none, a choice of OpenAI and a
   *  switch still owed to it both end: they were made with a key that is gone. */
  keyPresent: boolean
}

interface Cached extends Resolved {
  at: number
  gen: number
}

interface TrackedProvider extends EmbeddingProvider {
  retire(): void
}

let cached: Cached | null = null
let inflight: { gen: number; promise: Promise<EmbeddingResolution> } | null = null
/** Bumped by every invalidation: a probe started before one is never cached. */
let generation = 0
let pinned: EmbeddingResolution | null = null
let current: { provider: TrackedProvider; fingerprint: string | null } | null = null
let lastReadyId: string | null = null
/** Provider id plus key fingerprint: a replaced OpenAI key is a new provider. */
let lastReadyKey: string | null = null
/** The last OpenAI key seen and how many times it has changed. Only equality
 *  matters, so nothing derived from the key is ever computed or stored. */
let lastKey: string | null = null
let keyEpoch = 0
let lastEmbedError: string | null = null
let lastLoggedError: { message: string; at: number } | null = null
let ticker: ReturnType<typeof setInterval> | null = null

// ─── Provider health ─────────────────────────────────────────────────────────

/**
 * Wrap a provider so a failing call is seen here. Save-time embedding is
 * best-effort and swallows its own errors (the fact must still save), so this
 * wrapper is the only place a failing provider becomes visible. A failure
 * re-probes at once and is kept for the status line.
 */
function tracked(inner: EmbeddingProvider): TrackedProvider {
  let retired = false
  return {
    id: inner.id,
    dimensions: inner.dimensions,
    retire() {
      retired = true
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (retired) throw new EmbeddingProviderRetiredError(inner.id)
      try {
        const out = await inner.embed(texts)
        if (!retired) lastEmbedError = null
        return out
      } catch (err) {
        // Replaced while the call was out: its outcome belongs to no current
        // provider, and the replacement is already adopted.
        if (retired) throw err
        // The provider turned one input down (too long, say): the provider is
        // fine, so neither re-probe nor report it as failing.
        if (isRequestShapedEmbeddingError(err)) throw err
        const message = err instanceof Error ? err.message : String(err)
        lastEmbedError = message
        if (cached) cached = { ...cached, at: 0 }
        void getEmbeddingResolution()
        const now = Date.now()
        if (lastLoggedError?.message !== message || now - lastLoggedError.at > 60_000) {
          log.warn({ provider: inner.id, err: message }, 'embedding call failed')
          lastLoggedError = { message, at: now }
        }
        throw err
      }
    },
  }
}

/**
 * Swap in the resolved provider, reusing the tracked instance when nothing
 * changed (so anything holding it keeps working) and retiring it when it is
 * replaced. While nothing is usable, a local provider is kept rather than
 * retired: when the same Ollama comes back, everything that held it works
 * again. A remote one is retired at once, because the reason may be that its
 * key was disconnected.
 */
function adopt(r: Resolved): EmbeddingResolution {
  if (r.res.state !== 'ready') {
    if (current && isRemoteEmbeddingProvider(current.provider.id)) {
      current.provider.retire()
      current = null
    }
    return r.res
  }
  if (
    current &&
    current.provider.id === r.res.provider.id &&
    current.fingerprint === r.fingerprint
  ) {
    return { ...r.res, provider: current.provider }
  }
  current?.provider.retire()
  current = { provider: tracked(r.res.provider), fingerprint: r.fingerprint }
  return { ...r.res, provider: current.provider }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

function isStale(c: Cached, now: number): boolean {
  const localReady = c.res.state === 'ready' && !isRemoteEmbeddingProvider(c.res.provider.id)
  return now - c.at >= (localReady ? READY_TTL_MS : UNUSABLE_TTL_MS)
}

/** The provider id a "re-embed everything" is still owed to, if any. */
function reembedOwedTo(): string | null {
  try {
    return getSetting(getDb(), REEMBED_REQUEST_SETTING) || null
  } catch {
    return null
  }
}

function setReembedOwed(providerId: string | null): void {
  try {
    setSetting(getDb(), REEMBED_REQUEST_SETTING, providerId ?? '')
  } catch {
    /* the request is lost; the user can ask again */
  }
}

async function resolveFresh(): Promise<Resolved> {
  // Checked before the vault or the store is touched.
  if (embeddingsDisabled()) {
    return {
      res: { state: 'disabled', provider: null },
      fingerprint: null,
      remoteAvailable: false,
      keyPresent: true,
    }
  }
  // A key the user gave clawboo counts, not only one exported in the shell.
  // Deliberately NOT OpenClaw's ~/.openclaw/.env: that key was given to
  // OpenClaw, and embedding sends every fact's text to the provider.
  const openaiApiKey =
    process.env['OPENAI_API_KEY']?.trim() || getRuntimeSecret('OPENAI_API_KEY') || undefined
  // Local-first: a store that has had local vectors uses a cloud provider only
  // while the user's choice for this outage stands, and never without a key
  // (so an unreachable Ollama is reported as that, not as "no provider").
  const localFirst = storeIsLocalFirst(getDb())
  const consented = getSetting(getDb(), REMOTE_CONSENT_SETTING) === '1'
  const allowRemote = !localFirst || (consented && openaiApiKey != null)
  const res = await probeEmbeddingProvider({ openaiApiKey, allowRemote })
  const fingerprint =
    res.state === 'ready' && isRemoteEmbeddingProvider(res.provider.id) && openaiApiKey
      ? keyIdentity(openaiApiKey)
      : null
  return {
    res,
    fingerprint,
    remoteAvailable: openaiApiKey != null && !allowRemote,
    // Removed, not merely unreadable this once: a vault that failed to read,
    // or holds an entry it could not decrypt, still has the key.
    keyPresent: openaiApiKey != null || hasRuntimeSecret('OPENAI_API_KEY') || !isVaultReadable(),
  }
}

/**
 * The current resolution, re-probed when stale. Concurrent callers share one
 * probe. When a usable provider appears or changes, facts it has not indexed
 * are backfilled in the background.
 */
export async function getEmbeddingResolution(): Promise<EmbeddingResolution> {
  if (pinned) return pinned
  if (cached && cached.gen === generation && !isStale(cached, Date.now())) return cached.res
  if (!inflight || inflight.gen !== generation) {
    const gen = generation
    // Stamped at the start, so "every 30 seconds" is 30 seconds from the probe,
    // not from whenever it finished.
    const startedAt = Date.now()
    const promise: Promise<EmbeddingResolution> = resolveFresh()
      .catch((): Resolved => ({
        res: { state: 'none', provider: null },
        fingerprint: null,
        remoteAvailable: false,
        // Unknown: a failed probe must not withdraw a choice.
        keyPresent: true,
      }))
      .then((r): EmbeddingResolution | Promise<EmbeddingResolution> => {
        // Invalidated while probing: this answer predates the change.
        if (gen !== generation) return getEmbeddingResolution()
        const res = adopt(r)
        cached = { ...r, res, at: startedAt, gen }
        onResolved(res, r.fingerprint, r.keyPresent)
        return res
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
    inflight = { gen, promise }
  }
  return inflight.promise
}

function keyIdentity(key: string): string {
  if (key !== lastKey) {
    lastKey = key
    keyEpoch += 1
  }
  return `key-${keyEpoch}`
}

function onResolved(
  res: EmbeddingResolution,
  fingerprint: string | null,
  keyPresent: boolean,
): void {
  const readyId = res.state === 'ready' ? res.provider.id : null
  if (res.state !== 'disabled') {
    try {
      // Ollama serving ends the outage a choice of OpenAI answered, however
      // that choice arrived (a click on a note a poll behind included).
      if (readyId) noteEmbeddingProviderServing(getDb(), readyId)
      // With no key at all, the choice and any switch owed were made with a
      // key that is gone; a key connected later is a new decision.
      if (!keyPresent) {
        if (getSetting(getDb(), REMOTE_CONSENT_SETTING) === '1') {
          setSetting(getDb(), REMOTE_CONSENT_SETTING, '0')
        }
        if (reembedOwedTo()) setReembedOwed(null)
      }
    } catch {
      /* checked again on the next resolution */
    }
  }
  const readyKey = readyId ? `${readyId}:${fingerprint ?? ''}` : null
  if (readyKey === lastReadyKey) return
  if (readyId !== lastReadyId) {
    log.info({ from: lastReadyId, to: readyId, state: res.state }, 'embedding provider changed')
  }
  lastReadyId = readyId
  lastReadyKey = readyKey
  // The last pass's outcome and the last failure belonged to the provider
  // being replaced.
  lastBackfill = null
  lastEmbedError = null
  // A re-embed owed to another provider is void once this one serves.
  const owed = reembedOwedTo()
  if (readyId && owed && owed !== readyId) setReembedOwed(null)
  if (readyId) kickEmbeddingBackfill('provider-changed')
}

/** The usable provider, or null (vector and hybrid search then degrade to FTS). */
export async function getEmbedProvider(): Promise<EmbeddingProvider | null> {
  return (await getEmbeddingResolution()).provider
}

/** Start resolving without waiting, so the first request finds an answer. */
export function warmEmbedProvider(): void {
  if (!pinned) void getEmbeddingResolution()
}

/** Forget the cached answer; the next lookup re-probes. */
export function invalidateEmbedProvider(): void {
  generation += 1
  if (cached) cached = { ...cached, at: 0 }
}

/**
 * A provider key was connected or disconnected: re-decide now, so a removed
 * key stops being used straight away rather than at the next TTL. Removing
 * the OpenAI key is also an explicit end to a choice of OpenAI and to any
 * switch still owed to it, even when another key (one exported in the
 * server's environment, say) would otherwise keep OpenAI available.
 */
export function onEmbeddingKeysChanged(opts: { removed?: readonly string[] } = {}): void {
  if (opts.removed?.includes('OPENAI_API_KEY')) {
    try {
      if (getSetting(getDb(), REMOTE_CONSENT_SETTING) === '1') {
        setSetting(getDb(), REMOTE_CONSENT_SETTING, '0')
      }
      if (reembedOwedTo()) setReembedOwed(null)
    } catch {
      /* the next resolution without a key does the same */
    }
  }
  invalidateEmbedProvider()
  void getEmbeddingResolution()
}

// ─── Backfill ────────────────────────────────────────────────────────────────

interface BackfillRun extends BackfillEmbeddingsResult {
  at: number
}

let backfillRunning = false
let backfillPromise: Promise<void> = Promise.resolve()
/** Vectors written by indexing since the process started. Only ever grows, so
 *  a client can tell exactly when new similarity links can exist. */
let vectorsWritten = 0
let rerunRequested = false
/** The pass in flight, so the status counts what it is actually indexing. */
let activePass: { provider: EmbeddingProvider; includeOther: boolean } | null = null
let lastBackfill: BackfillRun | null = null
/** Facts a provider rejected on their own. Facts never change, so a rejection
 *  stands until the provider does; an explicit reindex clears it. */
const skippedByProvider = new Map<string, Set<string>>()

function skippedFor(providerId: string): Set<string> {
  let set = skippedByProvider.get(providerId)
  if (!set) {
    set = new Set()
    skippedByProvider.set(providerId, set)
  }
  return set
}

/**
 * Whether a pass should also replace vectors another provider produced. A
 * local provider converges the whole store. A remote one indexes only facts
 * that have no vector: shipping every already-indexed fact to a cloud API is
 * something the user asks for (Use OpenAI, or an explicit reindex), never a
 * side effect of a key being present.
 */
function includeOtherModels(providerId: string, reembedAll: boolean): boolean {
  return reembedAll || !isRemoteEmbeddingProvider(providerId)
}

/**
 * Index facts the current provider has no vector for. Single-flight: a kick
 * while a pass is running schedules one more pass after it, which covers a
 * provider that changed mid-pass. The running flag is cleared in the same
 * synchronous step as the last rerun check, so no kick can fall between them.
 * Detached and never throws.
 */
export function kickEmbeddingBackfill(reason: string): void {
  if (pinned) return // tests drive the store directly
  if (backfillRunning) {
    rerunRequested = true
    return
  }
  backfillRunning = true
  backfillPromise = runBackfill(reason)
}

async function runBackfill(reason: string): Promise<void> {
  try {
    do {
      rerunRequested = false
      await onePass(reason)
    } while (rerunRequested)
  } finally {
    backfillRunning = false
  }
}

async function onePass(reason: string): Promise<void> {
  const provider = await getEmbedProvider().catch(() => null)
  if (!provider) return
  const reembedAll = reembedOwedTo() === provider.id
  const includeOther = includeOtherModels(provider.id, reembedAll)
  const skip = skippedFor(provider.id)
  activePass = { provider, includeOther }
  let res: BackfillEmbeddingsResult
  try {
    const store = new SqliteMemoryStore(getDb(), provider)
    const pending = store.countFactsNeedingEmbedding(provider.id, {
      includeOtherModels: includeOther,
      excludeIds: [...skip],
    })
    res =
      pending === 0
        ? { embedded: 0, skipped: [], remaining: 0, error: null }
        : await store.backfillEmbeddings({ reembedOtherModels: includeOther, skipIds: [...skip] })
  } catch (err) {
    // A write that throws (disk full, a read-only file, a damaged FTS index)
    // must arm the same backoff an embed failure does, or every status poll
    // pays for the same batch again.
    res = {
      embedded: 0,
      skipped: [],
      remaining: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    activePass = null
  }
  vectorsWritten += res.embedded
  for (const id of res.skipped) skip.add(id)
  // A provider replaced mid-pass (a new key, say) failed with "no longer in
  // use": that outcome is not the new provider's to report, and the
  // replacement already requested its own pass (onResolved).
  if (provider === current?.provider) {
    lastBackfill = { at: Date.now(), ...res }
    // A switch is done when its provider has converged the store; until then
    // it stays owed, so a pass that stopped partway is retried, not forgotten.
    if (reembedAll && res.error == null && res.remaining === 0) setReembedOwed(null)
  }
  if (res.embedded > 0 || res.error || res.skipped.length > 0) {
    log.info(
      {
        reason,
        provider: provider.id,
        embedded: res.embedded,
        skipped: res.skipped.length,
        remaining: res.remaining,
        error: res.error,
      },
      'memory embedding backfill',
    )
  }
}

function recentlyFailed(): boolean {
  return lastBackfill?.error != null && Date.now() - lastBackfill.at < RETRY_AFTER_FAILURE_MS
}

function pendingFor(provider: EmbeddingProvider): number {
  const includeOther =
    (activePass?.provider === provider && activePass.includeOther) ||
    includeOtherModels(provider.id, reembedOwedTo() === provider.id)
  try {
    return new SqliteMemoryStore(getDb(), provider).countFactsNeedingEmbedding(provider.id, {
      includeOtherModels: includeOther,
      excludeIds: [...skippedFor(provider.id)],
    })
  } catch {
    return 0
  }
}

/** Facts the current provider turned down, for marking them in the graph. */
export async function skippedFactIds(): Promise<ReadonlySet<string>> {
  const provider = await getEmbedProvider().catch(() => null)
  return provider ? skippedFor(provider.id) : new Set()
}

/** Kick a pass when facts are waiting, unless one just failed. */
async function healIfPending(reason: string): Promise<void> {
  const provider = await getEmbedProvider().catch(() => null)
  if (!provider || backfillRunning || recentlyFailed()) return
  if (pendingFor(provider) > 0) kickEmbeddingBackfill(reason)
}

/**
 * An explicit request to index again. Clears this provider's skips and checks
 * the provider with one short string, so Retry reports the provider's health
 * (on the next status read) even when there is nothing to index. `reembedAll`
 * also replaces vectors from another provider, which an automatic pass would
 * not do for a remote provider; it is owed to the provider resolved here until
 * that provider has converged the store.
 */
export async function reindexEmbeddings(opts: {
  allowRemote?: boolean
  reembedAll?: boolean
}): Promise<void> {
  if (opts.allowRemote) setSetting(getDb(), REMOTE_CONSENT_SETTING, '1')
  invalidateEmbedProvider()
  // Resolving records whether Ollama is serving, which withdraws the consent
  // just written if the outage it was meant for is already over.
  const provider = await getEmbedProvider()
  // The user asked: the failure backoff is for automatic retries only.
  lastBackfill = null
  if (!provider) return
  skippedFor(provider.id).clear()
  if (opts.reembedAll) setReembedOwed(provider.id)
  kickEmbeddingBackfill('manual')
  // Off the request's path: a queued or stalled provider must not hold Retry.
  void provider.embed([HEALTH_CHECK_TEXT]).catch(() => undefined)
}

/**
 * Resolve at boot, and keep resolving: the timer re-probes whenever the cached
 * answer is stale and heals every few ticks, so facts an agent saved while
 * nobody had Memory open still get indexed.
 */
export function startMemoryEmbedding(): void {
  void getEmbeddingResolution()
  if (ticker) return
  let ticks = 0
  ticker = setInterval(() => {
    ticks += 1
    void getEmbeddingResolution()
    if (ticks % HEAL_EVERY_TICKS === 0) void healIfPending('timer')
  }, TICK_MS)
  ticker.unref?.()
}

// ─── Status (the UI's honesty line) ──────────────────────────────────────────

export interface EmbeddingStatus {
  state: EmbeddingResolution['state']
  provider: { id: string; dimensions: number } | null
  /** The provider sends fact text off this machine. */
  remote: boolean
  /** A model whose install is a real fix: either nothing can embed without it,
   *  or it would move embeddings from a remote provider onto this machine. */
  missingModel: string | null
  /** An OpenAI key exists that local-first is deliberately not using. */
  remoteAvailable: boolean
  /** Facts the running pass (or else an automatic one) would index; null with
   *  no provider. */
  pending: number | null
  /** Every fact in the store: what "Use OpenAI instead" would send. */
  factCount: number
  /** The store has had local vectors, so a remote provider serving means the
   *  user chose it for an Ollama outage. */
  localFirst: boolean
  /** Vectors written by indexing since the server started; only grows. */
  vectorsWritten: number
  /** Facts the provider rejected on their own (still matched by keyword). */
  skipped: number
  indexing: boolean
  installing: boolean
  /** The most recent embed or indexing failure. */
  lastError: string | null
}

export async function getEmbeddingStatus(): Promise<EmbeddingStatus> {
  const res = await getEmbeddingResolution()
  const provider = res.state === 'ready' ? res.provider : null
  const pending = provider ? pendingFor(provider) : null
  let factCount = 0
  let localFirst = false
  if (res.state !== 'disabled') {
    try {
      factCount = new SqliteMemoryStore(getDb()).countFacts()
      localFirst = storeIsLocalFirst(getDb())
    } catch {
      /* an unreadable store reports no facts */
    }
  }
  // Self-heal: asking for status is cheap and an open Memory view asks.
  if (provider && (pending ?? 0) > 0 && !backfillRunning && !recentlyFailed()) {
    kickEmbeddingBackfill('status-poll')
  }
  const missingModel =
    res.state === 'ollama-model-missing'
      ? res.model
      : res.state === 'ready' && res.localModelMissing
        ? res.localModelMissing.model
        : null
  return {
    state: res.state,
    provider: provider ? { id: provider.id, dimensions: provider.dimensions } : null,
    remote: provider != null && isRemoteEmbeddingProvider(provider.id),
    missingModel,
    remoteAvailable: !pinned && (cached?.remoteAvailable ?? false),
    pending,
    factCount,
    localFirst,
    vectorsWritten,
    skipped: provider ? skippedFor(provider.id).size : 0,
    indexing: backfillRunning,
    installing: pull !== null,
    lastError: lastBackfill?.error ?? lastEmbedError,
  }
}

// ─── Installing the model ────────────────────────────────────────────────────

export interface PullProgress {
  message: string
  completed?: number
  total?: number
}

export class PullInProgressError extends Error {
  constructor() {
    super('an embedding model install is already running')
    this.name = 'PullInProgressError'
  }
}

/** Ollama's statuses name digests and layers; say what is happening instead. */
function describePullStatus(status: string): string {
  if (status === 'pulling manifest') return 'Preparing the download'
  if (status.startsWith('pulling ')) return 'Downloading'
  if (status.startsWith('verifying')) return 'Verifying'
  return 'Finishing'
}

let pull: Promise<void> | null = null

/**
 * Pull the embedding model the resolver looks for through Ollama's own
 * `/api/pull`, streaming its progress. The model is fixed here, never taken
 * from a request: this endpoint exists to install one thing. On success the
 * provider is re-probed, which kicks the backfill.
 */
export function pullEmbeddingModel(
  onProgress: (p: PullProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  if (pull) return Promise.reject(new PullInProgressError())
  pull = (async () => {
    const res = await fetch(`${OLLAMA_DEFAULT_URL}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_DEFAULT_MODEL, stream: true }),
      signal,
    })
    if (!res.ok || !res.body) throw new Error(`Ollama refused the install (HTTP ${res.status})`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let succeeded = false
    // Bytes are reported per layer; follow only the largest (the model itself)
    // so the percentage does not restart for each small file after it.
    let largest = 0
    const handle = (line: string): void => {
      if (!line) return
      let frame: { status?: unknown; error?: unknown; completed?: unknown; total?: unknown }
      try {
        frame = JSON.parse(line) as typeof frame
      } catch {
        return
      }
      if (typeof frame.error === 'string') throw new Error(frame.error)
      if (typeof frame.status !== 'string') return
      if (frame.status === 'success') succeeded = true
      const total = typeof frame.total === 'number' ? frame.total : 0
      if (total > largest) largest = total
      const bytes =
        total > 0 && total === largest && typeof frame.completed === 'number'
          ? { completed: frame.completed, total }
          : {}
      onProgress({ message: describePullStatus(frame.status), ...bytes })
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        handle(line)
      }
    }
    handle((buf + decoder.decode()).trim())
    // A stream that ends without "success" did not install anything usable.
    if (!succeeded) throw new Error('the install ended before Ollama reported success')
    invalidateEmbedProvider()
    await getEmbeddingResolution()
  })().finally(() => {
    pull = null
  })
  return pull
}

// ─── Test seams ──────────────────────────────────────────────────────────────

/** Pin a resolution (or a bare provider, or null for FTS-only). Pinned mode
 *  never probes the network and never starts a background backfill. */
export function __pinEmbeddingForTests(
  value: EmbeddingResolution | EmbeddingProvider | null,
): void {
  if (value === null) pinned = { state: 'none', provider: null }
  else if ('state' in value) pinned = value
  else pinned = { state: 'ready', provider: value }
}

export function __resetEmbeddingForTests(): void {
  if (ticker) clearInterval(ticker)
  ticker = null
  cached = null
  inflight = null
  generation += 1
  pinned = null
  current = null
  lastReadyId = null
  lastReadyKey = null
  lastKey = null
  keyEpoch = 0
  lastEmbedError = null
  lastLoggedError = null
  lastBackfill = null
  rerunRequested = false
  activePass = null
  vectorsWritten = 0
  backfillRunning = false
  backfillPromise = Promise.resolve()
  skippedByProvider.clear()
  pull = null
}

/** Await whatever backfill is running (tests only). */
export function __backfillIdleForTests(): Promise<void> {
  return backfillPromise
}

/** Run one timer tick's work and wait for it (tests only). */
export async function __tickForTests(heal: boolean): Promise<void> {
  await getEmbeddingResolution()
  if (heal) await healIfPending('timer')
}
