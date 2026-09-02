// The community band, behind its own entry point.
//
// SEPARATE FROM `index.ts` ON PURPOSE, and the reason is the promise the main
// entry makes: a connector directory that renders with no fetch and no loading
// state, in an `npx clawboo` running on a plane. The curated 19 are a few
// kilobytes and stay statically imported so that promise holds for everything a
// user can actually turn on. The community snapshot is two orders of magnitude
// larger and is worth nothing until somebody scrolls past the divider or a
// curated search misses, so it is loaded with `await import()` at that moment.
//
// Importing this module is therefore a deliberate act by a caller that has
// decided the user wants breadth. Nothing in the default path reaches it.

export { COMMUNITY_SNAPSHOT } from './generated/community'
export type { ConnectorDefinition } from './types'
