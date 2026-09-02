// The supported schema-version window.
//
// Both ends are 1 today. They are still two constants rather than one, because
// the day a v2 lands the two stop being equal and every message that names the
// range has to keep reading correctly without being rewritten.

/** The oldest schema version this build can still read. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1 as const

/** The version this build writes, and the target every upgrade chain ends at. */
export const CURRENT_SCHEMA_VERSION = 1 as const

/** Human-readable window, for error text. */
export const SUPPORTED_RANGE = `${MIN_SUPPORTED_SCHEMA_VERSION}..${CURRENT_SCHEMA_VERSION}`

/** Alias kept for call sites that mean "the version this build writes". */
export const PACK_FORMAT_VERSION = CURRENT_SCHEMA_VERSION
