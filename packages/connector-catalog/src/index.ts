// @clawboo/connector-catalog — the committed, offline connector directory.
//
// Plain data plus lookups. No network, no zod at runtime, no side effects: the
// SPA imports it and renders a browsable directory with no loading state, which
// is what an `npx clawboo` running on a plane requires. Shape validation lives in
// the test suite, so the guarantee is enforced at build time rather than paid for
// on every page load.

export * from './types'
export * from './catalog'
export * from './snippet'
export * from './connectable'
export * from './launchArgs'
