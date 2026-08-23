// Whether clawboo can actually CONNECT a catalog entry today.
//
// ONE definition, two consumers: the REST handler enforces it and the browser
// renders it. A separate client-side guess is how a tile ends up offering a
// button the server then refuses -- the affordance-shaped lie this package's
// header already refuses to ship.
//
// Pure and dependency-free, computable from the definition alone, so the browser
// can call it with no round-trip.

import type { ConnectorDefinition } from './types'

/**
 * An argument the catalog expects a HUMAN to replace.
 *
 * `filesystem` is the live case: its args end in `/path/to/allowed/dir`, and the
 * upstream server throws during initialization without a real directory. A
 * Connect button for it would burn a cold `npx` install and then fail at the
 * handshake with an opaque timeout.
 */
export const PLACEHOLDER_ARG = /(^|\/)path\/to\/|^<.+>$/

/** Why an entry cannot be connected, or null when it can. */
export type ConnectRefusal =
  | 'community-unsandboxed'
  | 'remote-needs-oauth'
  | 'needs-credential'
  | 'needs-user-supplied-argument'

/** Human copy for each refusal. Names the ACTUAL obstacle, never a status code. */
export const CONNECT_REFUSAL_COPY: Readonly<Record<ConnectRefusal, string>> = Object.freeze({
  'community-unsandboxed':
    'Only curated connectors can be connected. A community server runs as you, unsandboxed.',
  'remote-needs-oauth': 'Sign in to this provider to connect it.',
  // These two are SOLVABLE, so their copy asks rather than refuses. The UI
  // renders a form for both; this text is the fallback for a surface that has
  // not fetched the config yet, and for the server's 422.
  'needs-credential': 'This connector needs a credential. Add one to connect it.',
  'needs-user-supplied-argument': 'This connector needs a path you supply. Add one to connect it.',
})

/**
 * The reason this entry cannot be connected, or null.
 *
 * Order matters only for which reason is REPORTED when several apply, and it is
 * ordered by what the operator would have to change first.
 */
export function connectRefusal(
  def: ConnectorDefinition,
  /**
   * Whether every REQUIRED credential is already stored.
   *
   * Passed in rather than read here, because only the server can see the vault
   * and this function has to stay browser-safe. Defaults to false, so a caller
   * that does not know yet gets the conservative answer.
   */
  credentialsSatisfied = false,
  /** Whether the operator has supplied the declared launch argument. */
  argumentSatisfied = false,
  /** Whether a remote connector has a usable OAuth token. */
  authorized = false,
): ConnectRefusal | null {
  // `custom` is connectable: the operator supplied the command themselves, which
  // is the same trust boundary as writing it into a runtime's own config. Only
  // `community` is blocked, because that is a one-click install of somebody
  // else's package.
  if (def.provenance === 'community') return 'community-unsandboxed'
  // Remote connectors are solvable too, once the operator has signed in. Only
  // the server can know whether they have, which is why this is a parameter
  // rather than something read here.
  if (def.launch.transport !== 'stdio' && !authorized) return 'remote-needs-oauth'
  // A missing credential is a refusal only until it is supplied. Treating it as
  // permanent is what made eight connectors look unreachable when the only thing
  // standing in the way was a value nobody had been asked for.
  if (def.auth.kind !== 'none' && !credentialsSatisfied) return 'needs-credential'
  // The DECLARED flag first: a server can require an argument the catalog simply
  // does not pass, in which case nothing about its args looks wrong. The pattern
  // below stays as a backstop for the visible case.
  // Solvable, exactly like a credential: a refusal only until the value exists.
  if (def.requiresUserArgument && !argumentSatisfied) return 'needs-user-supplied-argument'
  // The pattern backstop, for an entry that ships a placeholder without
  // declaring `requiresUserArgument`. Checked even when an argument HAS been
  // supplied, because a supplied value only helps if `resolveLaunchArgs` knows
  // where to put it -- and it only knows that from a declared `userArgument`.
  // Without this, an undeclared placeholder would sail through as connectable
  // and reach the spawn verbatim, which is the exact case this pattern exists
  // to catch.
  if (
    // Guarded on the transport: a remote launch has no `args` at all, and this
    // line was previously unreachable for one because the sign-in check above
    // returned first. Making that check solvable made this reachable.
    def.launch.transport === 'stdio' &&
    def.launch.args.some((a) => PLACEHOLDER_ARG.test(a)) &&
    (!def.userArgument || !argumentSatisfied)
  )
    return 'needs-user-supplied-argument'
  return null
}

/** Convenience for a renderer that only needs the boolean. */
export function isConnectable(
  def: ConnectorDefinition,
  credentialsSatisfied = false,
  argumentSatisfied = false,
  authorized = false,
): boolean {
  return connectRefusal(def, credentialsSatisfied, argumentSatisfied, authorized) === null
}

/** Whether the only thing missing is an OAuth sign-in the operator can do. */
export function needsSignInOnly(def: ConnectorDefinition): boolean {
  return (
    connectRefusal(def, true, true, false) === 'remote-needs-oauth' &&
    connectRefusal(def, true, true, true) === null
  )
}

/**
 * Whether the ONLY thing standing between this entry and a connection is a
 * credential the operator has not entered yet.
 *
 * Distinct from `isConnectable`, and the UI needs both: one decides whether to
 * show a Connect button, this one decides whether to show a form instead of a
 * flat "not connectable" message.
 */
export function needsCredentialOnly(def: ConnectorDefinition): boolean {
  return (
    connectRefusal(def, false, true) === 'needs-credential' &&
    connectRefusal(def, true, true) === null
  )
}

/** Whether the only thing missing is a launch argument the operator can type. */
export function needsArgumentOnly(def: ConnectorDefinition): boolean {
  return (
    connectRefusal(def, true, false) === 'needs-user-supplied-argument' &&
    connectRefusal(def, true, true) === null
  )
}

/** Everything an operator could make work, once they have filled in what it asks for. */
export function isReachable(def: ConnectorDefinition): boolean {
  return connectRefusal(def, true, true, true) === null
}
