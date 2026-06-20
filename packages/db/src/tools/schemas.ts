// ─── Tools zod schemas (REST + MCP boundary) ────────────────────────────────

import { z } from 'zod'

/** POST /api/tools/approvals/:id/resolve */
export const resolveApprovalBody = z.object({
  decision: z.enum(['allow_once', 'allow_always', 'deny']),
})
export type ResolveApprovalBody = z.infer<typeof resolveApprovalBody>

/** GET /api/tools query — scope the availability evaluation. */
export const listToolsQuery = z.object({
  agentId: z.string().optional(),
  teamId: z.string().optional(),
})
export type ListToolsQuery = z.infer<typeof listToolsQuery>
