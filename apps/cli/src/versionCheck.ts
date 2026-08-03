/**
 * apps/cli/src/versionCheck.ts
 *
 * Should the launcher offer to restart a server it just found?
 *
 * Mirrors `apps/web/server/lib/updateCheck.ts` — kept in lockstep:
 * - the semver regex and `semverGt`'s comparison rules are copied from its
 *   `parseSemver` / `semverGt` (the regex is character-identical; only the call
 *   form differs, `String.match` instead of `RegExp.exec`).
 * - `isDevVersion` mirrors the `isRealVersion` guard inside `computeSelfVersion`
 *   there, which is likewise `!current.startsWith('0.0.0')`.
 *
 * Duplicated rather than imported because `@clawboo/web` is private with no
 * exports, and importing it would drag the whole server graph into this bundle.
 * Same convention as the port-discovery mirror in `lifecycle.ts`.
 *
 * This module deliberately has ZERO imports so it stays trivially testable.
 */

function parseSemver(v: string): { core: [number, number, number]; pre: string } | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
}

/**
 * `a > b`? Compares major.minor.patch, then treats a release (`1.0.0`) as
 * greater than a prerelease of the same core (`1.0.0-beta`). Unparseable input
 * returns false, so an unrecognizable version can never be claimed as "newer".
 */
export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i]
  }
  if (pa.pre === pb.pre) return false
  if (pa.pre === '') return true // a is a release, b is a prerelease of the same core
  if (pb.pre === '') return false // b is the release → a (prerelease) is lower
  return pa.pre > pb.pre
}

/**
 * A dev checkout reads as `0.0.0*` — `0.0.0-dev` from this CLI without tsup's
 * define, or from the server when `readVersionFromDisk()` finds no `clawboo`
 * manifest. Deliberately narrow: `0.0.1` is a real release.
 */
export function isDevVersion(v: string): boolean {
  return v.startsWith('0.0.0')
}

/**
 * True only when both sides are real releases and THIS CLI is strictly newer
 * than the server it found.
 *
 * Every guard earns its place:
 * - `serverVersion === null` — the version was unreadable (a server that
 *   predates the endpoint, non-JSON, timeout, offline). Degrade to attaching;
 *   never block the browser on a check that failed.
 * - a dev CLI never nags — running `tsx src/index.ts` in a checkout.
 * - a dev SERVER is never targeted — otherwise a globally-installed `clawboo`
 *   would offer to SIGTERM someone's `pnpm dev` session.
 * - the comparison is one-directional: an older CLI attaching to a newer server
 *   (`npx clawboo@0.2` against a global 0.3) stays silent rather than offering
 *   a downgrade.
 */
export function shouldOfferRestart(cliVersion: string, serverVersion: string | null): boolean {
  if (serverVersion === null) return false
  if (isDevVersion(cliVersion) || isDevVersion(serverVersion)) return false
  return semverGt(cliVersion, serverVersion)
}
