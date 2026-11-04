// The URL prefix the server templated into the shell (`window.__CLAWBOO_BASE__`).
//
// Kept apart from `bootstrapBase.ts`, which hands the answer to the control client
// as an import side effect, so code that only needs to READ the prefix (the
// scoped browser storage in `lib/clientStorage.ts`) can import it without one.

/** The prefix the server templated into the shell, or '' when served at the root. */
export function readInjectedBase(): string {
  const raw = (globalThis as { __CLAWBOO_BASE__?: unknown }).__CLAWBOO_BASE__
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '/') return ''
  // Defensive: the server normalizes before injecting, so this only guards a
  // hand-edited shell. Same shape the contract guarantees (leading slash, no
  // trailing slash) so `${base}/api/...` keeps exactly one slash.
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  // Scanned, not `/\/+$/`: that pattern backtracks polynomially on a long run of
  // slashes, and this reads a value out of the document.
  let end = withLeading.length
  while (end > 0 && withLeading[end - 1] === '/') end -= 1
  return withLeading.slice(0, end)
}
