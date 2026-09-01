// Which upstream app a brokered call is actually aimed at.
//
// WHY THIS EXISTS. A broker is one MCP session carrying many upstream apps, so
// its tools are not one-per-app: Composio serves seven meta-tools and the app is
// an ARGUMENT. A grant keyed on the session therefore authorises every app the
// operator ever connected, and a grant keyed on one app matches no tool name at
// all. Reading the app off the arguments is what makes a per-app grant mean
// something, and it is the only place that information exists.
//
// FAIL CLOSED. An argument shape this does not recognise returns `unknown`
// rather than "no app", because "no app" reads as "nothing to check" and would
// wave through exactly the call that changed shape. The caller turns `unknown`
// into an approval, so a schema change costs a prompt rather than a silent hole.
//
// NOT EVERY TOOL IS APP-SCOPED, and the two that are not are the dangerous ones.
// Composio's remote workbench runs Python with `run_composio_tool` preloaded and
// its bash tool runs shell commands, so either can reach any app from inside
// code this can never read. They are reported as `unscoped`, and no per-app
// grant may stand in for one.

/** The names of the broker meta-tools that execute against an upstream app. */
const EXECUTING = new Set(['COMPOSIO_MULTI_EXECUTE_TOOL'])

/** Meta-tools that name apps but only read: discovery and connection management. */
const DISCOVERY = new Set([
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_WAIT_FOR_CONNECTIONS',
])

/**
 * Meta-tools that are not app-scoped at all.
 *
 * A remote shell and a remote Python sandbox. Composio preloads
 * `run_composio_tool` into the workbench, so an agent holding it can reach any
 * connected app from inside a string of code. Nothing that reads arguments can
 * bound them, so they are never covered by an app grant.
 */
const UNSCOPED = new Set(['COMPOSIO_REMOTE_BASH_TOOL', 'COMPOSIO_REMOTE_WORKBENCH'])

export type BrokeredAppScope =
  /** Not a broker meta-tool; the ordinary connector grant governs it alone. */
  | { kind: 'not-brokered' }
  /** Reaches anything, so it needs its own grant rather than an app grant. */
  | { kind: 'unscoped'; tool: string }
  /** Names these apps. Every one of them must be granted. */
  | { kind: 'apps'; toolkits: readonly string[]; executing: boolean }
  /** A recognised meta-tool whose arguments did not yield an app. */
  | { kind: 'unknown'; tool: string }

/** The bare tool name, with the MCP namespace prefix removed. */
function bareName(name: string): string {
  const last = name.split('__').pop() ?? name
  return last.toUpperCase()
}

/**
 * The toolkit a Composio tool slug belongs to.
 *
 * LONGEST MATCH WINS, because a prefix up to the first underscore is wrong for
 * every toolkit whose own slug contains one: `MICROSOFT_TEAMS_SEND_MESSAGE`
 * would resolve to `microsoft`, which is not a toolkit and would fail closed on
 * a call that is perfectly ordinary.
 */
function toolkitOf(toolSlug: string, known: readonly string[]): string | null {
  const slug = toolSlug.toUpperCase()
  let best: string | null = null
  for (const toolkit of known) {
    const prefix = toolkit.toUpperCase()
    if (!slug.startsWith(prefix)) continue
    // A prefix must end at a boundary, or `GITHUB` would claim `GITHUBACTIONS`.
    const next = slug.charAt(prefix.length)
    if (next !== '' && next !== '_') continue
    if (best === null || prefix.length > best.length) best = toolkit
  }
  return best
}

/** Every string under `key`, however the caller nested it. */
function collectStrings(value: unknown, key: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, key, out)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === key && typeof v === 'string') out.push(v)
    else collectStrings(v, key, out)
  }
}

/**
 * What this call is aimed at.
 *
 * `known` is the broker's own toolkit vocabulary, supplied by the caller: the
 * catalog owns that list and this package must not depend on it.
 */
export function brokeredAppScope(
  toolName: string,
  args: Record<string, unknown>,
  known: readonly string[],
): BrokeredAppScope {
  const name = bareName(toolName)
  if (UNSCOPED.has(name)) return { kind: 'unscoped', tool: name }

  const executing = EXECUTING.has(name)
  if (!executing && !DISCOVERY.has(name)) return { kind: 'not-brokered' }

  // `tool_slug` is what COMPOSIO_MULTI_EXECUTE_TOOL carries per entry; `name`
  // is what COMPOSIO_MANAGE_CONNECTIONS carries inside its `toolkits` array.
  // Both are read, because a caller may legitimately use either shape.
  const slugs: string[] = []
  collectStrings(args, 'tool_slug', slugs)
  collectStrings(args['toolkits'], 'name', slugs)
  for (const raw of ['toolkit', 'toolkit_slug']) {
    const v = args[raw]
    if (typeof v === 'string') slugs.push(v)
    else if (Array.isArray(v)) for (const s of v) if (typeof s === 'string') slugs.push(s)
  }

  if (slugs.length === 0) {
    // Discovery with no app named is a search over everything, which reveals
    // nothing an operator has not already connected and executes nothing.
    return executing ? { kind: 'unknown', tool: name } : { kind: 'not-brokered' }
  }

  const toolkits = new Set<string>()
  for (const slug of slugs) {
    const toolkit = toolkitOf(slug, known)
    if (toolkit === null) return { kind: 'unknown', tool: name }
    toolkits.add(toolkit)
  }
  return { kind: 'apps', toolkits: [...toolkits], executing }
}

/** The grant identity for one app reached through a broker. */
export function brokeredAppConnectorId(connectorId: string, toolkit: string): string {
  return `${connectorId}:app:${toolkit}`
}

/**
 * Which bucket a broker meta-tool falls in, from its name alone.
 *
 * `app-facing` tools are the broker's transport. They do nothing on their own:
 * every app they can reach is checked per app against a grant, so gating the
 * transport a SECOND time per agent would make an app grant useless without a
 * session grant as well, and force every operator to think about a layer that
 * carries no authority of its own.
 *
 * `unscoped` is the opposite. A remote shell and a Python sandbox with
 * `run_composio_tool` preloaded reach anything, so nothing per-app can bound
 * them and they stay governed by the session grant, by name.
 */
export function brokeredMetaToolKind(toolName: string): 'app-facing' | 'unscoped' | null {
  const name = bareName(toolName)
  if (UNSCOPED.has(name)) return 'unscoped'
  if (EXECUTING.has(name) || DISCOVERY.has(name)) return 'app-facing'
  return null
}

/**
 * Whether this broker meta-tool only LOOKS things up.
 *
 * WHY IT MATTERS. A connector that can reach the network is classed `external`,
 * and the risk inspector asks a human before every external call that is not
 * marked read-only. Composio advertises no `readOnlyHint`, so its catalogue
 * SEARCH and its schema READ were treated as external side effects: an agent
 * that merely wanted to find the right Gmail tool raised an approval, waited two
 * minutes for a human who was looking at a chat window rather than the approvals
 * queue, and reported the timeout to the operator as "the Composio service is
 * unavailable". These two tools execute nothing at all.
 *
 * `COMPOSIO_MANAGE_CONNECTIONS` is deliberately absent: `action: 'add'` mints a
 * new authorisation link, which is a side effect worth asking about.
 */
export function isBrokeredReadOnlyMetaTool(toolName: string): boolean {
  const name = bareName(toolName)
  return name === 'COMPOSIO_SEARCH_TOOLS' || name === 'COMPOSIO_GET_TOOL_SCHEMAS'
}
