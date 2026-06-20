// ─── Memory — 2-tier facts + procedures, FTS5 + vector ─────────
export type {
  BrowseOpts,
  EmbeddingProvider,
  Fact,
  MemoryScope,
  MemorySearchResult,
  MemoryStore,
  Procedure,
  SaveFactInput,
  SaveProcedureInput,
  SearchMode,
  SearchOpts,
} from './types'

export { SqliteMemoryStore } from './store'

export {
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  DeterministicEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAiEmbeddingProvider,
  resolveEmbeddingProvider,
  type ResolveEmbeddingOpts,
} from './embedding'

export { buildStructuredSummary, type StructuredSummaryInput } from './summary'

export {
  memoryScopeSchema,
  searchModeSchema,
  saveFactBody,
  saveProcedureBody,
  saveMemoryBody,
  searchMemoryBody,
  browseMemoryBody,
  type SaveFactBody,
  type SaveProcedureBody,
  type SaveMemoryBody,
  type SearchMemoryBody,
  type BrowseMemoryBody,
  type MemoryScopeBody,
} from './schemas'
