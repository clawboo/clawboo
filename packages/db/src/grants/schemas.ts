// ─── Grants zod schemas (REST boundary) ─────────────────────────────────────
// The house rule: apps/web has no zod dependency, so every REST body schema
// lives in a package and is imported by name. These three are pinned to the
// ALREADY-SHIPPED callers in apps/web/src/features/graph/operations/, so a
// change here is a wire break, not a refactor.

import { z } from 'zod'

/**
 * POST /api/grants
 *
 * `connectorId` and `capabilityId` are BOTH nullable and at least one must be
 * present: the client sends whichever identity the tile carried. `refine` rather
 * than a union so the error names the actual problem.
 */
export const createGrantBody = z
  .object({
    subjectKind: z.enum(['agent', 'team', 'global']),
    subjectId: z.string().min(1).nullable().optional(),
    capabilityKind: z.enum(['connector', 'tool', 'skill']),
    connectorId: z.string().min(1).nullable().optional(),
    capabilityId: z.string().min(1).nullable().optional(),
    mode: z.enum(['read', 'write', 'admin']).optional(),
    approvalPolicy: z.enum(['never', 'risk', 'writes', 'always']).optional(),
    toolAllow: z.array(z.string()).optional(),
    toolDeny: z.array(z.string()).optional(),
    // Absent means "leave it alone", never "clear it". The repository's update
    // set is presence-gated for exactly this reason.
    expiresAt: z.number().int().positive().nullable().optional(),
    callCeilingPerHour: z.number().int().positive().nullable().optional(),
  })
  .refine((b) => b.connectorId != null || b.capabilityId != null, {
    message: 'one of connectorId or capabilityId is required',
  })
  .refine((b) => b.subjectKind === 'global' || (b.subjectId != null && b.subjectId.length > 0), {
    message: 'subjectId is required unless subjectKind is global',
  })
export type CreateGrantBody = z.infer<typeof createGrantBody>

/** POST /api/grants/:id/revoke: body is optional and usually absent. */
export const revokeGrantBody = z.object({
  reason: z.string().max(200).nullable().optional(),
})
export type RevokeGrantBody = z.infer<typeof revokeGrantBody>

/** GET /api/grants */
export const listGrantsQuery = z.object({
  subjectId: z.string().optional(),
})
export type ListGrantsQuery = z.infer<typeof listGrantsQuery>
