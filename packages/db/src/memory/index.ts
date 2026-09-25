// ─── Memory — 2-tier facts + procedures, FTS5 + vector ─────────
export type {
  BrowseOpts,
  EmbeddingProvider,
  Fact,
  MemoryOutcome,
  MemoryProvenance,
  MemoryScope,
  MemorySearchResult,
  MemoryStore,
  OutcomeKind,
  Procedure,
  RecordOutcomeInput,
  SaveFactInput,
  SaveProcedureInput,
  SearchMode,
  SearchOpts,
} from './types'

export {
  SqliteMemoryStore,
  EMBED_TEXT_MAX_CHARS,
  EMBED_TEXT_RETRY_CHARS,
  factEmbeddingText,
  noteEmbeddingProviderServing,
  storeAllowsRemoteEmbedding,
  storeIsLocalFirst,
  type BackfillEmbeddingsOpts,
  type BackfillEmbeddingsResult,
} from './store'

export {
  computeLearningOverlay,
  LEARNING_HALF_LIFE_MS,
  type LearningEntry,
  type LearningOpts,
  type LearningStatus,
  type LearningTrailItem,
} from './learning'

export {
  computeFactEdges,
  neighborsOf,
  projectMemoryGraph,
  similarityAvailableFor,
  type ComputeFactEdgesOpts,
  type FactVectorRow,
  type MemoryFactEdge,
  type MemoryGraphCommunity,
  type MemoryGraphEdgeKind,
  type MemoryGraphNode,
  type MemoryGraphPayload,
  type MemoryNodeScope,
  type ProjectMemoryGraphOpts,
} from './graph'

export {
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  DeterministicEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAiEmbeddingProvider,
  EmbeddingHttpError,
  embeddingsDisabled,
  isRemoteEmbeddingProvider,
  isRequestShapedEmbeddingError,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_URL,
  ollamaHasModel,
  LOCAL_FIRST_SETTING,
  probeEmbeddingProvider,
  REEMBED_REQUEST_SETTING,
  REMOTE_EMBEDDING_CONSENT_SETTING,
  resolveEmbeddingProvider,
  type EmbeddingResolution,
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
  feedbackOutcomeSchema,
  feedbackBody,
  outcomesQuery,
  memoryGraphQuery,
  type SaveFactBody,
  type SaveProcedureBody,
  type SaveMemoryBody,
  type SearchMemoryBody,
  type BrowseMemoryBody,
  type MemoryScopeBody,
  type FeedbackBody,
  type OutcomesQuery,
  type MemoryGraphQuery,
} from './schemas'
