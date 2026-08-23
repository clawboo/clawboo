// The connector CATALOG entry — a definition, not an instance.
//
// Three nouns, kept apart on purpose, because collapsing them is exactly why the
// reference implementations cannot ship revoke, scopes or expiry:
//   TYPE     this file — what a connector IS. No user state.
//   INSTANCE the `connectors` row — a configured, possibly-authenticated install.
//   TOOL     a `capabilities` row — one callable verb the instance exposes.
//
// Committed as TypeScript rather than fetched at runtime. A connector browser in
// an offline `npx clawboo` must not have a loading state, and the official MCP
// registry is a preview API that ships data-reset warnings — so the snapshot IS
// the content address, and CI verifies it with the network switched off.

/** Coarse grouping for the directory's category pills. */
export type ConnectorCategory =
  | 'dev'
  | 'issues'
  | 'chat'
  | 'docs'
  | 'data'
  | 'observability'
  | 'browser'
  | 'search'
  | 'productivity'
  | 'finance'

/**
 * Where the entry came from, and therefore how much we are willing to claim.
 * - `curated`   first-party, hand-written, smoke-tested by us.
 * - `community` ingested from the official registry snapshot. Automated checks only.
 * - `custom`    the operator typed it in themselves. We vouch for nothing and say
 *               so; the trust is the same as pasting a server into a runtime's own
 *               config, which is a thing they can already do without us.
 *
 * The UI must render these as a hard visual split and never merge the counts into
 * a single "1000+" number. That claim is the one the reference implementations
 * make and cannot support.
 *
 * The distinction that matters for RUNNING one: `custom` is a command the
 * operator chose, which is why it can be connected today. `community` is a
 * one-click install of a package they may never have heard of, which is why it
 * cannot until a sandbox exists.
 */
export type ConnectorProvenance = 'curated' | 'community' | 'custom'

/** How the connector authenticates. `none` renders as "Active", not "Connect". */
export type ConnectorAuthKind = 'none' | 'api-key' | 'bearer' | 'oauth'

/** One credential the connector needs. Names only — a value never appears here. */
export interface ConnectorInput {
  /** The env var or header name, e.g. `GITHUB_TOKEN`. */
  key: string
  /** One line, plain verbs: "A GitHub personal access token with repo scope." */
  description: string
  /** Where a human goes to mint it. Rendered as a link in the consent dialog. */
  docsUrl?: string
  required: boolean
  /** True ⇒ store in the vault, never in a config file, never echoed back. */
  secret: boolean
}

/**
 * OAuth setup guidance carried AS DATA, not as prose in our docs.
 *
 * Stolen from qm's `OAuthProviderConfig.setupGuide`: the per-provider steps are
 * the part that actually blocks a user, and keeping them next to the provider
 * definition is what stops them rotting in a wiki nobody opens.
 */
export interface ConnectorSetupGuide {
  /** The vendor console's name, e.g. "GitHub Developer Settings". */
  console: string
  url: string
  /** Ordered, imperative, one action each. */
  steps: string[]
}

export interface ConnectorAuthSpec {
  kind: ConnectorAuthKind
  inputs: ConnectorInput[]
  /** PINNED. Never the provider's full `scopes_supported` catalog. */
  scopes?: string[]
  /** One sentence the consent dialog shows verbatim: why these scopes. */
  scopesRationale?: string
  setupGuide?: ConnectorSetupGuide
}

/** stdio launch shape. `args` order is meaningful and must never be sorted. */
export interface ConnectorStdioLaunch {
  transport: 'stdio'
  command: string
  args: string[]
  /**
   * The exact version this entry was verified against, already baked into `args`.
   *
   * A bare `npx -y <pkg>` resolves to `@latest` on EVERY spawn, so the code that
   * actually executes changes with no consent event — silently defeating the
   * spec pin, because drift detection only fires AFTER the new version has
   * already run and already read the child environment. Pin, or do not ship.
   */
  pinnedVersion: string
}

export interface ConnectorHttpLaunch {
  transport: 'streamable-http'
  url: string
}

export type ConnectorLaunch = ConnectorStdioLaunch | ConnectorHttpLaunch

/**
 * The trifecta legs this connector CAN contribute, at its most permissive.
 * A conservative upper bound, not a measurement — the runtime union across a run
 * is what `decideGrant` actually gates on.
 */
export interface ConnectorTrifectaHint {
  readsPrivateData: boolean
  ingestsUntrustedContent: boolean
  canEgress: boolean
}

/**
 * An argument the operator supplies, described well enough to ask for it.
 *
 * `replacesArg` is what keeps this from being a second, parallel way of building
 * argv: a catalog entry either has a placeholder token to substitute, or it
 * appends. Both go through `resolveLaunchArgs`, so there is exactly one function
 * that decides what a connector is actually run with.
 */
export interface ConnectorUserArgument {
  /** Shown as the field label, e.g. "Folder clawboo may read and write". */
  label: string
  /** One line under the field. Plain verbs, no jargon. */
  description: string
  /** A realistic example, shown as the input placeholder. */
  example: string
  /**
   * The exact argv token to replace. Omit to APPEND the value instead.
   *
   * `filesystem` carries `/path/to/allowed/dir` and needs substitution; `sqlite`
   * carries nothing and needs an append.
   */
  replacesArg?: string
}

export interface ConnectorDefinition {
  /** Stable kebab-case identity. The dialect key and the catalog's primary key. */
  slug: string
  displayName: string
  /** Plain verbs, user-facing: "Read and send emails." Not "Gmail API v1 integration." */
  description: string
  category: ConnectorCategory
  provenance: ConnectorProvenance
  launch: ConnectorLaunch
  auth: ConnectorAuthSpec
  /** Hosts this connector legitimately talks to. Seeds the instance egress allowlist. */
  egressAllow: string[]
  trifecta: ConnectorTrifectaHint
  /**
   * The server refuses to start without an argument only a human can supply.
   *
   * DECLARED rather than inferred. A placeholder-shaped arg is detectable by
   * pattern, but the harder case is a server that takes a REQUIRED argument the
   * catalog simply does not pass -- `mcp-server-sqlite-npx` exits 1 with
   * `Usage: mcp-server-sqlite-npx <database-path>`, and its args look perfectly
   * ordinary. Verified by running it; do not remove without doing the same.
   */
  requiresUserArgument?: boolean
  /** What that argument IS, so the UI can ask for it in words a user recognises. */
  userArgument?: ConnectorUserArgument
  tags: string[]
  homepage?: string
  /** Registry id when the entry came from a snapshot, e.g. `io.github.org/server`. */
  catalogId?: string
  /** Set when upstream marks the entry deprecated; the UI shows the message. */
  deprecatedMessage?: string
}
