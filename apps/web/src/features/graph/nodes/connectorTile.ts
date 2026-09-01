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

/**
 * The slug whose LOGO this tile should draw, or null.
 *
 * DELIBERATELY MORE PERMISSIVE THAN `connectorSlugFromId`, and the difference is
 * the whole reason this is a second function rather than a flag on the first.
 * That one answers "which connector do I send a disconnect at", where a wrong
 * answer acts on something the operator did not choose, so it refuses anything
 * clawboo did not dial itself. This one answers "whose logo is this", where the
 * worst case is a recognisable picture on a tile that already carries the name
 * underneath it.
 *
 * That extra reach is the point: a runtime attaches its own MCP servers, and
 * `conn:codex:codex:mcp:github` is GitHub whether or not clawboo dialled it.
 * Refusing to draw the logo there would leave the one tile a reader could have
 * identified at a glance looking like every anonymous one.
 *
 * THE CATALOG IS THE FILTER. A candidate has to resolve to a committed entry
 * that owns a brand mark, so `tools` and `clawboo-memory` fall through to the
 * service glyph rather than matching something they are not.
 */
export function connectorBrandSlug(
  connectorId: string | null | undefined,
  hasMark: (slug: string) => boolean,
  fullName?: string | null,
): string | null {
  const owned = connectorSlugFromId(connectorId)
  if (owned && hasMark(owned)) return owned

  const candidates = [connectorId?.split(':').pop(), fullName]
    .map((c) => c?.trim().toLowerCase())
    .filter((c): c is string => Boolean(c))

  for (const candidate of candidates) {
    if (hasMark(candidate)) return candidate
    // A runtime routinely prefixes its own servers. Stripping it is safe here
    // because the catalog still has to recognise what is left.
    const stripped = candidate.replace(/^clawboo-/, '')
    if (stripped !== candidate && hasMark(stripped)) return stripped
  }
  return null
}
