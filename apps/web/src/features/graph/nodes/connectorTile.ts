// Which graph tiles clawboo can actually act on.
//
// A connector tile's toolbar offers Turn off and a real Sign in, and both send a
// SLUG at the connectors API. Getting the slug wrong means sending a disconnect
// at something that does not exist, so the derivation is here, on its own, and
// tested. It is one line of string work and it was wrong in the obvious way
// first: every runtime's attached MCP servers also carry a connectorId.

import { connectorBySlug } from '@clawboo/connector-catalog'

/**
 * The catalog slug for a connector clawboo itself owns, or null.
 *
 * Connector ids are `conn:<sourceId>:<runtime>:<sourceKey>`. Only `connector` is
 * a connection clawboo spawned or dialled; `native`, `codex`, `claude-code` and
 * `hermes` all emit ids in the same shape for servers THEY attached. Taking the
 * last segment of one of those yields something like `tools`, which is not a
 * catalog slug, and acting on it would be a disconnect aimed at nothing.
 */
export function connectorSlugFromId(connectorId: string | null | undefined): string | null {
  if (!connectorId || !connectorId.startsWith('conn:connector:')) return null
  return connectorId.split(':').pop() || null
}

/**
 * Whether stopping this connector stops a PROCESS or closes a session.
 *
 * Only affects what the toast may claim. A remote connector never had a child to
 * kill, and saying otherwise told the operator something had been stopped on
 * their machine when nothing had.
 */
export function isRemoteConnector(slug: string | null): boolean {
  if (!slug) return false
  // UNKNOWN MEANS LOCAL, not remote. A custom connector the operator added is not
  // in the committed catalog, so `connectorBySlug` returns undefined for it, and
  // `undefined?.launch.transport !== 'stdio'` is true. Every custom connector
  // would have been called remote, and turning one off would have claimed a
  // session closed while a child process on the machine was being killed.
  return connectorBySlug(slug)?.launch.transport === 'streamable-http'
}
