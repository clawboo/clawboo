// Connectors the operator added themselves.
//
// THIS IS THE ANSWER TO "how many connectors are there". The committed catalog
// is 19 entries we have actually run and vouch for; it is a starting set, not a
// ceiling. Anything speaking MCP over stdio can be pointed at from here.
//
// WHY THIS IS CONNECTABLE WHEN COMMUNITY ENTRIES ARE NOT. Both run as the user,
// unsandboxed, so the technical risk is identical. The difference is consent: a
// custom connector is a command the operator typed, which is exactly what they
// would otherwise paste into their own runtime's config file. A community entry
// is a one-click install of a package chosen from a list of a thousand, most of
// which nobody in the room has heard of. The first is a decision; the second is
// a habit, and a habit is what a supply-chain attack needs.
//
// Stored in `settings` rather than the `connectors` table because a definition
// is not an instance: it exists before anything connects and survives a
// disconnect.

import { getSetting, setSetting, type ClawbooDb } from '@clawboo/db'
import type { ConnectorDefinition } from '@clawboo/connector-catalog'

const KEY = 'connectors:custom'

/** What the operator supplies. Deliberately small. */
export interface CustomConnectorInput {
  slug: string
  displayName: string
  description?: string
  command: string
  args: string[]
}

function parse(raw: string | null): CustomConnectorInput[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is CustomConnectorInput =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as CustomConnectorInput).slug === 'string' &&
        typeof (e as CustomConnectorInput).command === 'string' &&
        Array.isArray((e as CustomConnectorInput).args),
    )
  } catch {
    return []
  }
}

export function listCustomConnectors(db: ClawbooDb): CustomConnectorInput[] {
  return parse(getSetting(db, KEY))
}

/**
 * Present a custom entry in the SAME shape as a catalog one.
 *
 * Everything downstream -- the refusal predicate, the supervisor, the browser --
 * then treats it identically, so a custom connector cannot drift into a second
 * code path with its own bugs.
 *
 * The trifecta is declared at its most permissive because we know nothing about
 * this server: claiming otherwise would put a reassuring badge on a program
 * nobody has inspected. That also gives it an `external` risk floor at the gate.
 */
export function toDefinition(entry: CustomConnectorInput): ConnectorDefinition {
  return {
    slug: entry.slug,
    displayName: entry.displayName,
    description: entry.description ?? 'A connector you added.',
    category: 'dev',
    provenance: 'custom',
    launch: {
      transport: 'stdio',
      command: entry.command,
      args: entry.args,
      // Nothing to pin: the operator chose this command, and inventing a version
      // for it would be a claim we cannot support.
      pinnedVersion: 'user-supplied',
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: ['*'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['custom'],
  }
}

export function saveCustomConnector(db: ClawbooDb, entry: CustomConnectorInput): void {
  const rest = listCustomConnectors(db).filter((e) => e.slug !== entry.slug)
  setSetting(db, KEY, JSON.stringify([...rest, entry]))
}

export function deleteCustomConnector(db: ClawbooDb, slug: string): boolean {
  const all = listCustomConnectors(db)
  const rest = all.filter((e) => e.slug !== slug)
  if (rest.length === all.length) return false
  setSetting(db, KEY, JSON.stringify(rest))
  return true
}

/** A custom entry by slug, already in catalog shape. */
export function customConnectorBySlug(db: ClawbooDb, slug: string): ConnectorDefinition | null {
  const entry = listCustomConnectors(db).find((e) => e.slug === slug)
  return entry ? toDefinition(entry) : null
}
