// ─── Connector lifecycle zod schemas (REST boundary) ────────────────────────
// apps/web has no zod dependency by house rule, so every REST body schema lives
// in a package and is imported by name.

import { z } from 'zod'

/** POST /api/connectors/connect */
export const connectConnectorBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(48)
    // The catalog's own slug rule. Validated here because this value reaches a
    // process spawn: anything looser and the identity that keys a grant stops
    // being the thing the catalog vouched for.
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'not a catalog slug'),
})
export type ConnectConnectorBody = z.infer<typeof connectConnectorBody>
