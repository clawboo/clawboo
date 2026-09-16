// ─── Memory zod schemas ─────────────────────────────────────────────────────
// Validate REST request bodies (apps/web/server/api/memory.ts) AND MCP tool
// inputs (@clawboo/mcp memory server) at the boundary — one source of truth for
// the shapes so both surfaces validate identically.

import { z } from 'zod'

export const memoryScopeSchema = z.object({
  agentId: z.string().nullish(),
  teamId: z.string().nullish(),
  tenantId: z.string().nullish(),
})
export type MemoryScopeBody = z.infer<typeof memoryScopeSchema>

export const searchModeSchema = z.enum(['fts', 'vector', 'hybrid'])

export const saveFactBody = z.object({
  kind: z.literal('fact').optional(),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(50_000),
  tags: z.array(z.string().max(100)).max(50).optional(),
  scope: memoryScopeSchema.optional(),
})
export type SaveFactBody = z.infer<typeof saveFactBody>

export const saveProcedureBody = z.object({
  kind: z.literal('procedure'),
  name: z.string().min(1).max(200),
  content: z.string().min(1).max(100_000),
  scope: memoryScopeSchema.optional(),
})
export type SaveProcedureBody = z.infer<typeof saveProcedureBody>

/** POST /api/memory accepts a fact (default) or a procedure (discriminated). */
export const saveMemoryBody = z.union([saveFactBody, saveProcedureBody])
export type SaveMemoryBody = z.infer<typeof saveMemoryBody>

export const searchMemoryBody = z.object({
  query: z.string().min(1).max(2_000),
  mode: searchModeSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  scope: memoryScopeSchema.optional(),
})
export type SearchMemoryBody = z.infer<typeof searchMemoryBody>

export const browseMemoryBody = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  scope: memoryScopeSchema.optional(),
})
export type BrowseMemoryBody = z.infer<typeof browseMemoryBody>

/** Explicit feedback outcomes only — 'cited' is internal (the injection write
 *  path) and deliberately absent so usage counts cannot be forged externally. */
export const feedbackOutcomeSchema = z.enum(['useful', 'dead_end', 'corrected'])

export const feedbackBody = z.object({
  factId: z.string().min(8).max(64),
  outcome: feedbackOutcomeSchema,
  note: z.string().max(2_000).optional(),
  scope: memoryScopeSchema.optional(),
})
export type FeedbackBody = z.infer<typeof feedbackBody>

export const outcomesQuery = z.object({
  factId: z.string().min(8).max(64),
  limit: z.number().int().min(1).max(200).optional(),
})
export type OutcomesQuery = z.infer<typeof outcomesQuery>

export const memoryGraphQuery = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  scope: memoryScopeSchema.optional(),
})
export type MemoryGraphQuery = z.infer<typeof memoryGraphQuery>
