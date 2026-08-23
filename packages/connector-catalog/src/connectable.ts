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
  'remote-needs-oauth': 'Remote connectors need an OAuth sign-in, which is not implemented yet.',
  'needs-credential': 'This connector needs a credential, and there is no way to supply one yet.',
  'needs-user-supplied-argument':
    'This connector needs a path you have to fill in, and per-connector settings are not implemented yet.',
})

/**
 * The reason this entry cannot be connected, or null.
 *
 * Order matters only for which reason is REPORTED when several apply, and it is
 * ordered by what the operator would have to change first.
 */
export function connectRefusal(def: ConnectorDefinition): ConnectRefusal | null {
  if (def.provenance !== 'curated') return 'community-unsandboxed'
  if (def.launch.transport !== 'stdio') return 'remote-needs-oauth'
  if (def.auth.kind !== 'none') return 'needs-credential'
  // The DECLARED flag first: a server can require an argument the catalog simply
  // does not pass, in which case nothing about its args looks wrong. The pattern
  // below stays as a backstop for the visible case.
  if (def.requiresUserArgument) return 'needs-user-supplied-argument'
  if (def.launch.args.some((a) => PLACEHOLDER_ARG.test(a))) return 'needs-user-supplied-argument'
  return null
}

/** Convenience for a renderer that only needs the boolean. */
export function isConnectable(def: ConnectorDefinition): boolean {
  return connectRefusal(def) === null
}
