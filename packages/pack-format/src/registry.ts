// The version ladder.
//
// `SCHEMAS[n]` validates a document that DECLARES version n. `UPGRADES[n]`
// rewrites an n document into an n+1 document. A reader validates at the
// declared version first, then walks the chain up to `CURRENT_SCHEMA_VERSION`,
// then validates again.
//
// UPGRADES IS EMPTY, AND THAT IS THE POINT. There is exactly one version, so
// there is nothing to upgrade. The scaffold exists now, with the empty map
// spelled out, so that adding v2 is "write `upgrade1to2` and add two entries"
// rather than "invent a migration story under deadline". A ladder retrofitted
// after the second version ships is a ladder that has already lost the first
// rung: Claude Code's permanent `metadata.description` dual-read is what that
// costs.

import { agentPackV1, agentPackV1Strict } from './schema'

/** Rewrites a document from one schema version to the next. */
export type Upgrade = (doc: Record<string, unknown>) => Record<string, unknown>

/** Validators keyed by the version a document DECLARES. */
export const SCHEMAS = {
  1: agentPackV1,
} as const

/** Same, but unknown keys are an error. Used by the in-repo gate. */
export const STRICT_SCHEMAS = {
  1: agentPackV1Strict,
} as const

/**
 * `UPGRADES[n]` turns an n document into an n+1 document.
 *
 * Empty at v1, by design. Do not add a no-op entry to make it look populated:
 * an identity upgrade would make the self-check that follows the chain
 * (`upgrade-produced-invalid-document`) pass vacuously.
 */
export const UPGRADES: Readonly<Record<number, Upgrade>> = {}

/** Every version this build has a validator for, ascending. */
export const KNOWN_SCHEMA_VERSIONS: readonly number[] = Object.keys(SCHEMAS)
  .map(Number)
  .sort((a, b) => a - b)
