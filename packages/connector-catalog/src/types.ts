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
 *
 * The UI must render these as a hard visual split and never merge the counts into
 * a single "1000+" number. That claim is the one the reference implementations
 * make and cannot support.
 */
export type ConnectorProvenance = 'curated' | 'community'

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
  tags: string[]
  homepage?: string
  /** Registry id when the entry came from a snapshot, e.g. `io.github.org/server`. */
  catalogId?: string
  /** Set when upstream marks the entry deprecated; the UI shows the message. */
  deprecatedMessage?: string
}
