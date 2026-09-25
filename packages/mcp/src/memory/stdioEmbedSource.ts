// The stdio Memory bin's embedding provider: resolved (an Ollama with the
// model, then OPENAI_API_KEY from this process's environment, then none) and
// re-resolved once a minute, so starting Ollama or pulling the model takes
// effect without restarting the bin. It applies the dashboard's rules: a store
// that has had local vectors stays local unless the user chose OpenAI for the
// current outage, and finding Ollama serving withdraws that choice.

import {
  embeddingsDisabled,
  noteEmbeddingProviderServing,
  resolveEmbeddingProvider,
  storeAllowsRemoteEmbedding,
  type ClawbooDb,
  type EmbeddingProvider,
  type ResolveEmbeddingOpts,
} from '@clawboo/db'

export interface StdioEmbedSourceDeps {
  resolve?: (opts: ResolveEmbeddingOpts) => Promise<EmbeddingProvider | null>
  now?: () => number
  everyMs?: number
}

export function createStdioEmbedSource(
  db: ClawbooDb,
  deps: StdioEmbedSourceDeps = {},
): () => Promise<EmbeddingProvider | null> {
  const resolve = deps.resolve ?? resolveEmbeddingProvider
  const now = deps.now ?? Date.now
  const everyMs = deps.everyMs ?? 60_000
  let cached: { at: number; provider: Promise<EmbeddingProvider | null> } | null = null
  return () => {
    if (embeddingsDisabled()) return Promise.resolve(null)
    if (!cached || now() - cached.at >= everyMs) {
      // A store that cannot be read is treated as local-first: never widen.
      let allowRemote = false
      try {
        allowRemote = storeAllowsRemoteEmbedding(db)
      } catch {
        /* keep local-only */
      }
      cached = {
        at: now(),
        provider: resolve({ allowRemote })
          .then((provider) => {
            try {
              if (provider) noteEmbeddingProviderServing(db, provider.id)
            } catch {
              /* checked again at the next resolve */
            }
            return provider
          })
          .catch(() => null),
      }
    }
    return cached.provider
  }
}
