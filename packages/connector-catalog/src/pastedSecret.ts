// What a person actually pastes when they mean to paste a token.
//
// EVERY CASE HERE IS A REAL THING PEOPLE PASTE, and every one of them stores a
// value that looks right in a password field and fails at the vendor with an
// error that names none of this. A leading `Bearer ` comes from copying a curl
// example; surrounding quotes come from a shell `export` line or a JSON
// snippet; trailing whitespace and newlines come from selecting a line in a
// terminal or a docs page.
//
// APPLIED IN THE FIELD, not only on save, so the operator SEES the cleaned
// value before committing to it. Cleaning invisibly is its own trap: it works
// until the day it guesses wrong, and then the user is looking at a value that
// is not the one being stored.

/** A prefix people paste from an HTTP example. Case-insensitive, one only. */
const AUTH_SCHEME = /^\s*(?:Bearer|Token|Basic)\s+/i

/**
 * The token inside whatever the operator pasted around it.
 *
 * CONSERVATIVE BY DESIGN. Quotes are stripped only as a MATCHED pair wrapping
 * the whole value, because a quote can legitimately occur inside a secret and
 * removing an unmatched one would corrupt a valid token to fix a typo nobody
 * made. Everything else here is a prefix or surrounding whitespace, neither of
 * which any credential format uses as content.
 */
export function cleanPastedSecret(raw: string): string {
  let v = raw.trim()
  v = v.replace(AUTH_SCHEME, '')
  // Matched pair only, and repeated so `'"abc"'` unwraps: shells and JSON nest.
  for (;;) {
    const first = v[0]
    const last = v[v.length - 1]
    if (v.length >= 2 && (first === '"' || first === "'" || first === '`') && last === first) {
      v = v.slice(1, -1).trim()
      continue
    }
    break
  }
  // A second pass, because `"Bearer abc"` is a real paste: the quotes hid the
  // scheme from the first one.
  const after = v.replace(AUTH_SCHEME, '')
  return after === v ? v : after.trim()
}
