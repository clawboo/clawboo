// ─── Embedding providers + vector helpers ───────────────────────────────────
// The `EmbeddingProvider` seam: an offline-first Ollama default (reuses
// clawboo's existing Ollama integration), an OpenAI fallback when a key is
// present, and a deterministic offline provider for tests/CI. When none is
// available, vector/hybrid search gracefully falls back to FTS.

import type { EmbeddingProvider } from './types'

// ─── Vector math (pure) ──────────────────────────────────────────────────────

/** Cosine similarity in [-1, 1]. Returns 0 for length-mismatch or zero vectors. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Pack a number[] embedding into a little-endian Float32 BLOB for SQLite. */
export function serializeEmbedding(vec: number[]): Buffer {
  const f32 = Float32Array.from(vec)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

/** Unpack a Float32 BLOB back into a Float32Array (or null for empty/odd input). */
export function deserializeEmbedding(
  blob: Buffer | Uint8Array | null | undefined,
): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null
  // Copy into an aligned buffer — better-sqlite3 Buffers may be offset-unaligned.
  const copy = Buffer.from(blob)
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

// ─── Deterministic provider (tests / offline default) ────────────────────────
// A bag-of-words hashing embedder: FNV-1a per token → bucket → tf, L2-normalized.
// NOT semantically rich, but deterministic + offline + fast — texts that share
// tokens get higher cosine, which is enough to exercise vector/hybrid ranking.

const DETERMINISTIC_DIMS = 64

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'deterministic'
  readonly dimensions = DETERMINISTIC_DIMS

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((text) => {
        const vec = new Array<number>(DETERMINISTIC_DIMS).fill(0)
        for (const tok of tokenize(text)) {
          vec[fnv1a(tok) % DETERMINISTIC_DIMS] += 1
        }
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
        return norm === 0 ? vec : vec.map((v) => v / norm)
      }),
    )
  }
}

// ─── Provider errors ─────────────────────────────────────────────────────────

/**
 * A provider answered with a non-2xx. The status separates "this request was
 * bad" (one input too long: skip that fact and carry on) from "the provider is
 * not working" (auth, quota, missing model, outage: stop and say so).
 */
export class EmbeddingHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider} embed failed: ${status}`)
    this.name = 'EmbeddingHttpError'
  }
}

/** The request itself was rejected, as opposed to the provider being unusable. */
export function isRequestShapedEmbeddingError(err: unknown): boolean {
  return err instanceof EmbeddingHttpError && [400, 413, 422].includes(err.status)
}

// ─── Ollama provider (offline-first, local) ──────────────────────────────────

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434'
/** The embedding model the resolver looks for, and the one the install action pulls. */
export const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text'

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  private readonly baseUrl: string
  private readonly model: string

  constructor(opts: { baseUrl?: string; model?: string; dimensions?: number } = {}) {
    this.baseUrl = opts.baseUrl ?? OLLAMA_DEFAULT_URL
    this.model = opts.model ?? OLLAMA_DEFAULT_MODEL
    this.dimensions = opts.dimensions ?? 768
    this.id = `ollama:${this.model}`
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Newer Ollama: POST /api/embed { model, input: string[] } → { embeddings }.
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    })
    if (!res.ok) throw new EmbeddingHttpError('Ollama', res.status)
    const json = (await res.json()) as { embeddings?: number[][] }
    if (!Array.isArray(json.embeddings)) throw new Error('Ollama embed: no embeddings in response')
    return json.embeddings
  }
}

// ─── OpenAI provider (fallback when a key is present) ────────────────────────

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; dimensions?: number }) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? 'text-embedding-3-small'
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
    this.dimensions = opts.dimensions ?? 1536
    this.id = `openai:${this.model}`
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    })
    if (!res.ok) throw new EmbeddingHttpError('OpenAI', res.status)
    const json = (await res.json()) as { data?: { embedding: number[] }[] }
    if (!Array.isArray(json.data)) throw new Error('OpenAI embed: no data in response')
    return json.data.map((d) => d.embedding)
  }
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export interface ResolveEmbeddingOpts {
  /** Explicit provider wins (used by tests). */
  provider?: EmbeddingProvider
  /** Probe Ollama at this URL (default http://localhost:11434). */
  ollamaUrl?: string
  ollamaModel?: string
  /** OpenAI key (falls back to process.env.OPENAI_API_KEY). */
  openaiApiKey?: string
  /** Probe timeout for the Ollama reachability check. */
  probeTimeoutMs?: number
  /**
   * False keeps embeddings local: no OpenAI fallback. The server passes false
   * once a store holds Ollama vectors, so a brief Ollama outage cannot quietly
   * switch the team's memory to a cloud provider. Default true.
   */
  allowRemote?: boolean
}

/** What Ollama's `/api/tags` reported. `reachable` false covers down, refused,
 *  timed out and a non-2xx answer alike. */
interface OllamaTagsProbe {
  reachable: boolean
  models: string[]
}

async function probeOllamaTags(baseUrl: string, timeoutMs: number): Promise<OllamaTagsProbe> {
  // The timer covers the body read too: a server that sends headers and then
  // stalls would otherwise hang every caller of the resolver.
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal })
    if (!res.ok) return { reachable: false, models: [] }
    const json = (await res.json()) as { models?: { name?: unknown; model?: unknown }[] }
    const models = (Array.isArray(json.models) ? json.models : [])
      .map((m) =>
        typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : '',
      )
      .filter((n) => n.length > 0)
    return { reachable: true, models }
  } catch {
    return { reachable: false, models: [] }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Whether an installed-model list satisfies a model reference. Ollama resolves
 * an untagged reference to `:latest`, so a bare `nomic-embed-text` is met by
 * `nomic-embed-text:latest` and by nothing else (a pulled `:v1.5` is a
 * different model as far as `/api/embed` is concerned). A tagged reference
 * must match exactly.
 */
export function ollamaHasModel(installed: readonly string[], model: string): boolean {
  const want = model.includes(':') ? model : `${model}:latest`
  return installed.some((name) => name === want || name === model)
}

/**
 * Where resolution landed and why. `ready` is the only state that carries a
 * provider; every other state is a reason the UI can state and act on.
 *
 * `ollama-model-missing` exists because a reachable Ollama is not a usable
 * one: with the embedding model not pulled, every `/api/embed` call 404s, so
 * it must never be reported as a provider.
 */
export type EmbeddingResolution =
  | {
      state: 'ready'
      provider: EmbeddingProvider
      /** A remote provider is serving while a local Ollama runs without the
       *  model: installing it would keep embeddings on this machine. */
      localModelMissing?: { model: string; baseUrl: string }
    }
  | { state: 'disabled'; provider: null }
  | { state: 'ollama-model-missing'; provider: null; model: string; baseUrl: string }
  /** Local-only (allowRemote false) and Ollama is not answering. */
  | { state: 'ollama-unreachable'; provider: null; baseUrl: string }
  | { state: 'none'; provider: null }

/**
 * Pick an embedding provider for the live (REST / bin) path and say why.
 * Order: explicit provider, then a local Ollama that HAS the embedding model
 * (offline-first), then an OpenAI key, then nothing (FTS-only). A reachable
 * Ollama without the model falls through to OpenAI when a key exists, since a
 * working provider beats a diagnostic, and is reported as
 * `ollama-model-missing` only when nothing else can serve.
 */
export async function probeEmbeddingProvider(
  opts: ResolveEmbeddingOpts = {},
): Promise<EmbeddingResolution> {
  if (opts.provider) return { state: 'ready', provider: opts.provider }
  if (embeddingsDisabled()) return { state: 'disabled', provider: null }
  const ollamaUrl = opts.ollamaUrl ?? OLLAMA_DEFAULT_URL
  const ollamaModel = opts.ollamaModel ?? OLLAMA_DEFAULT_MODEL
  const tags = await probeOllamaTags(ollamaUrl, opts.probeTimeoutMs ?? 1500)
  if (tags.reachable && ollamaHasModel(tags.models, ollamaModel)) {
    return {
      state: 'ready',
      provider: new OllamaEmbeddingProvider({ baseUrl: ollamaUrl, model: ollamaModel }),
    }
  }
  const allowRemote = opts.allowRemote ?? true
  const key = allowRemote ? (opts.openaiApiKey ?? process.env['OPENAI_API_KEY']) : undefined
  if (key) {
    return {
      state: 'ready',
      provider: new OpenAiEmbeddingProvider({ apiKey: key }),
      ...(tags.reachable ? { localModelMissing: { model: ollamaModel, baseUrl: ollamaUrl } } : {}),
    }
  }
  if (tags.reachable) {
    return { state: 'ollama-model-missing', provider: null, model: ollamaModel, baseUrl: ollamaUrl }
  }
  if (!allowRemote) return { state: 'ollama-unreachable', provider: null, baseUrl: ollamaUrl }
  return { state: 'none', provider: null }
}

/**
 * Escape hatch: force FTS-only (no vector or hybrid search) regardless of what
 * is reachable. Lets an operator opt out of embeddings, and gives the e2e a
 * deterministic graph (tag and version edges only). Callers that would read a
 * key or open the store to resolve a provider check this first.
 */
export function embeddingsDisabled(): boolean {
  return process.env['CLAWBOO_DISABLE_EMBEDDINGS'] === '1'
}

/** Set when the user chose OpenAI while a locally indexed store's Ollama was
 *  not answering. It answers that one outage: any process that finds Ollama
 *  serving clears it (noteEmbeddingProviderServing). */
export const REMOTE_EMBEDDING_CONSENT_SETTING = 'memory-embedding:remote-consent'

/** Set once any fact has been given an Ollama vector. Local-first is a fact
 *  about the store's history, so replacing every local vector (a switch to
 *  OpenAI during an outage) does not make the store cloud-first. */
export const LOCAL_FIRST_SETTING = 'memory-embedding:local-first'

/** The provider id an explicit "re-embed everything" is still owed to. It
 *  survives a failed pass and a restart, and is dropped once that provider has
 *  converged the store or another provider takes over. */
export const REEMBED_REQUEST_SETTING = 'memory-embedding:reembed-for'

/** True for a provider that sends fact text off this machine. */
export function isRemoteEmbeddingProvider(id: string): boolean {
  return id.startsWith('openai:')
}

/** `probeEmbeddingProvider` without the reason, for callers that only need the provider. */
export async function resolveEmbeddingProvider(
  opts: ResolveEmbeddingOpts = {},
): Promise<EmbeddingProvider | null> {
  return (await probeEmbeddingProvider(opts)).provider
}
