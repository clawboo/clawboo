// Is this string one immutable release, or something that resolves differently tomorrow?
//
// THE CONTRACT THIS DEFENDS. A community entry's consent step shows the operator
// the exact argv before anything runs, and that promise is only worth something
// if the argv names one immutable artifact. `npx -y pkg@latest` shows a command
// that is honest about its text and dishonest about its effect: the operator
// reads it on Tuesday, approves it, and runs whatever the publisher pushed on
// Thursday. A dist-tag, a range, or a URL all have that property.
//
// The registry's `version` field is publisher-supplied and unvalidated, so
// nothing upstream stops `latest` or `^1.2.0` arriving in a snapshot.

/** npm: exact semver. `1.2.3`, `1.2.3-rc.1`, `1.2.3+build.5`. */
const EXACT_SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * PyPI: an exact PEP 440 release.
 *
 * Deliberately narrower than PEP 440 allows. Local versions (`1.0+ubuntu`) and
 * the `===` arbitrary-equality form are legal Python and are not things a
 * registry row should be pinning a public package to, so they are refused
 * rather than reasoned about.
 */
const EXACT_PEP440 = /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/

export type PackageEcosystem = 'npm' | 'pypi'

/**
 * True only for a version that names one immutable release.
 *
 * Refuses dist-tags (`latest`, `next`), ranges (`^1.2.0`, `>=1`, `1.x`, `*`),
 * URLs, git refs, and anything carrying whitespace. Refusing is the safe
 * direction: a rejected entry is one card the directory does not show, while an
 * accepted mutable one is an approval the operator did not actually give.
 */
export function isExactVersion(version: string | undefined, ecosystem: PackageEcosystem): boolean {
  if (typeof version !== 'string') return false
  // Compared against the raw string, NOT a trimmed copy: a version that needed
  // trimming to pass is one whose argv would not match what was verified.
  if (version.length === 0 || version.length > 64) return false
  if (/[\s^~><=*|,]/.test(version)) return false
  if (version.includes('://') || version.includes('@')) return false
  return ecosystem === 'npm' ? EXACT_SEMVER.test(version) : EXACT_PEP440.test(version)
}
