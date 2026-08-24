// The ONE function that decides what a connector is actually run with.
//
// Two catalog entries need an argument only a human can supply, and they need it
// in two different shapes: `filesystem` carries a placeholder token to replace,
// `sqlite` carries nothing and needs an append. Expressing that as two code
// paths would mean two chances to get argv wrong, so it is one function with a
// declared difference.
//
// Pure and browser-safe, so the consent dialog can show exactly the argv the
// spawn will use rather than an approximation of it.

import type { ConnectorDefinition } from './types'

/**
 * The argv a connector should be launched with.
 *
 * Returns the catalog args unchanged when the entry declares no user argument,
 * so the common case carries none of this machinery.
 */
export function resolveLaunchArgs(def: ConnectorDefinition, userValue?: string): string[] {
  const base = def.launch.transport === 'stdio' ? [...def.launch.args] : []
  const spec = def.userArgument
  if (!spec || !userValue) return base

  if (spec.replacesArg) {
    // Substitute EVERY occurrence rather than the first: an entry that repeats
    // its placeholder means it twice, and replacing one would produce argv that
    // is half-configured and fails in a way nobody would trace back here.
    return base.map((arg) => (arg === spec.replacesArg ? userValue : arg))
  }
  return [...base, userValue]
}

/** Whether a supplied value would actually satisfy the declared requirement. */
export function launchArgsSatisfied(def: ConnectorDefinition, userValue?: string): boolean {
  if (!def.requiresUserArgument) return true
  return typeof userValue === 'string' && userValue.trim().length > 0
}
