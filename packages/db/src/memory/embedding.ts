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

// ─── Ollama provider (offline-first, local) ──────────────────────────────────

const OLLAMA_DEFAULT_URL = 'http://localhost:11434'
const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text'

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
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`)
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
    if (!res.ok) throw new Error(`OpenAI embed failed: ${res.status}`)
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
}

async function ollamaReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Pick an embedding provider for the live (REST / bin) path. Order: explicit
 * provider → reachable Ollama (offline-first default) → OpenAI key → null
 * (FTS-only). Resolved once at construction by the caller, not per-query.
 */
export async function resolveEmbeddingProvider(
  opts: ResolveEmbeddingOpts = {},
): Promise<EmbeddingProvider | null> {
  if (opts.provider) return opts.provider
  const ollamaUrl = opts.ollamaUrl ?? OLLAMA_DEFAULT_URL
  if (await ollamaReachable(ollamaUrl, opts.probeTimeoutMs ?? 1500)) {
    return new OllamaEmbeddingProvider({ baseUrl: ollamaUrl, model: opts.ollamaModel })
  }
  const key = opts.openaiApiKey ?? process.env['OPENAI_API_KEY']
  if (key) return new OpenAiEmbeddingProvider({ apiKey: key })
  return null
}
