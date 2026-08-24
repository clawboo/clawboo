// Tool-name namespacing for connector-supplied tools.
//
// WHY A HANDLE AND NOT THE CONNECTOR ID. The grant identity is
// `conn:<sourceId>:<runtime>:<sourceKey>` and contains colons. Tool names reach
// model providers that fold every character outside [A-Za-z0-9_-] to `_`, and
// that transform is NOT injective: `a.b` and `a_b` arrive as the same name. So
// the identity cannot ride in the name, and anything lossy cannot either.
//
// The namespace segment is therefore the connector SLUG -- unique-indexed in
// `connectors`, kebab-case by catalog rule, and free of the `_` this scheme uses
// as its separator. The slug-to-identity mapping is a side table the caller
// holds; `ToolCallContext.connectorId` is how it reaches the gate.
//
// ONE TOOL, NOT ONE CONNECTOR. A remote name that cannot be represented is
// skipped with a reason, never silently renamed and never fatal to its whole
// connector: dropping one unusable tool is recoverable, refusing to connect a
// server because one of its forty tools has a dot in its name is not.

/** Marks a tool as brokered on a connector's behalf. */
export const CONNECTOR_TOOL_PREFIX = 'mcp'

/** The separator. Chosen because a catalog slug can never contain `_`. */
const SEP = '__'

/** Characters that survive every downstream name normalisation unchanged. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/
/** The catalog's slug rule, restated so this module validates its own inputs. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/

/** Why a remote tool could not be given a namespaced name. */
export type NamespaceRejection = 'invalid-slug' | 'unrepresentable-name' | 'name-too-long'

/**
 * Provider limits vary; 128 is the smallest widely-enforced cap. Truncating
 * would collide two tools onto one name, so an over-long name is rejected.
 */
const MAX_TOOL_NAME = 128

export type NamespaceResult = { ok: true; name: string } | { ok: false; reason: NamespaceRejection }

/** `mcp__<slug>__<remoteName>`, or a reason it cannot be represented. */
export function namespacedToolName(slug: string, remoteName: string): NamespaceResult {
  if (!SAFE_SLUG.test(slug)) return { ok: false, reason: 'invalid-slug' }
  // Deliberately NOT sanitised. A name we rewrite is a name that no longer
  // matches what the server will accept on tools/call, and two rewritten names
  // can collide.
  if (!SAFE_NAME.test(remoteName)) return { ok: false, reason: 'unrepresentable-name' }
  const name = `${CONNECTOR_TOOL_PREFIX}${SEP}${slug}${SEP}${remoteName}`
  if (name.length > MAX_TOOL_NAME) return { ok: false, reason: 'name-too-long' }
  return { ok: true, name }
}

/**
 * Recover the slug and the server's own tool name.
 *
 * The remote half may itself contain `__`; the slug never can, so splitting on
 * the first two separators is unambiguous.
 */
export function parseNamespacedToolName(name: string): { slug: string; remoteName: string } | null {
  const prefix = `${CONNECTOR_TOOL_PREFIX}${SEP}`
  if (!name.startsWith(prefix)) return null
  const rest = name.slice(prefix.length)
  const at = rest.indexOf(SEP)
  if (at <= 0) return null
  const slug = rest.slice(0, at)
  const remoteName = rest.slice(at + SEP.length)
  // The parser must accept EXACTLY what the constructor can emit. A looser
  // parser would classify `mcp__github__a.b` as a connector tool even though
  // `namespacedToolName` refuses to produce it, so a name arriving from a
  // persisted row or a hand-written config would be routed to a connector on
  // the strength of its prefix alone.
  if (!SAFE_SLUG.test(slug) || !SAFE_NAME.test(remoteName)) return null
  if (name.length > MAX_TOOL_NAME) return null
  return { slug, remoteName }
}

/** Whether a name belongs to a connector rather than to clawboo itself. */
export function isConnectorToolName(name: string): boolean {
  return parseNamespacedToolName(name) !== null
}
