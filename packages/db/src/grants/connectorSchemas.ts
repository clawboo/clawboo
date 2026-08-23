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

/** PUT /api/connectors/:slug/config */
export const setConnectorConfigBody = z.object({
  /**
   * A launch argument the operator supplies (a folder, a database file).
   *
   * NOT a credential, and stored outside the vault on purpose: it has to be
   * showable back to the operator, because checking which folder a connector was
   * given is the whole point of asking for it.
   */
  argument: z.string().max(4096).optional(),
  /**
   * Credential values, by declared env-var name.
   *
   * An EMPTY string means "clear this one", which is why the value is not
   * `.min(1)`: without an explicit clear, a credential entered by mistake could
   * only be removed by editing the vault by hand.
   */
  values: z
    .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'not an env-var name'), z.string().max(8192))
    .optional(),
})
export type SetConnectorConfigBody = z.infer<typeof setConnectorConfigBody>

/**
 * POST /api/connectors/custom
 *
 * The operator points clawboo at a server of their own. Validated tightly
 * because `command` and `args` become a real process: the slug has to be
 * catalog-shaped (it becomes a tool-name segment and a grant identity), and args
 * are an ARRAY so nothing here is ever shell-parsed.
 */
export const createCustomConnectorBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
  displayName: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  command: z.string().min(1).max(1024),
  // Bounded so a definition cannot become an unbounded argv, and each entry
  // bounded so one cannot become a megabyte the child has to parse.
  args: z.array(z.string().max(2048)).max(64).default([]),
})
export type CreateCustomConnectorBody = z.infer<typeof createCustomConnectorBody>
