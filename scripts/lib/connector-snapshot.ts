// The community snapshot's integrity digest, owned in one place.
//
// WHY THIS EXISTS. `generated/community.ts` carried a `// Digest:` line that
// nothing ever checked, so a hand-edit to any of its 230 entries passed every
// gate: `verify:connectors` checks SHAPE, and shape is exactly what an attacker
// editing an argv would preserve. The snapshot is the content address for a
// directory of unreviewed installers, so an unverified digest is the one place
// this feature could not afford a decorative check.
//
// WHY THE HASH IS OVER THE CANONICAL FORM. The digest used to be computed over
// the generator's raw output, but lint-staged runs Prettier over every staged
// .ts file and `.prettierignore` does not exempt `generated/`, so the bytes on
// disk are the restyled ones and the recorded hash could never be reproduced
// from them. Hashing `prettier.format(...)` makes the value invariant to code
// style, to a `.prettierrc` change, and to CRLF on a Windows checkout. It is
// the same decision `scripts/lib/ingest-manifest.ts` already made for the
// marketplace catalog, for the same reasons.
//
// WHY THE DIGEST LINE IS BLANKED FIRST. The digest lives inside the file it
// describes, so hashing the file as-is would be circular. Both sides replace
// that one line with a fixed placeholder before hashing, which keeps the header
// (source URL, entry count, cap) inside the covered bytes instead of leaving it
// as the one part of the file anybody could rewrite freely.

import { createHash } from 'node:crypto'

import prettier from 'prettier'

/** The header line carrying the digest. Matched, blanked, never parsed for meaning. */
const DIGEST_LINE = /^\/\/ Digest: .*$/m

/** What the digest line reads as while the digest over it is being computed. */
export const DIGEST_PLACEHOLDER = '// Digest: <computed>'

/** Render the header line for a known digest. One definition, two callers. */
export function digestLine(hex: string): string {
  return `// Digest: ${hex}`
}

/**
 * The digest of a snapshot file's canonical form.
 *
 * Idempotent: writer and verifier agree regardless of whether the file on disk
 * has been through Prettier yet.
 */
export async function snapshotDigest(fileText: string, filePath: string): Promise<string> {
  const blanked = fileText.replace(DIGEST_LINE, DIGEST_PLACEHOLDER)
  const canonical = await prettier.format(blanked, { parser: 'typescript', filepath: filePath })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** The digest a snapshot file claims for itself, or null when it claims none. */
export function recordedDigest(fileText: string): string | null {
  const m = fileText.match(/^\/\/ Digest: ([0-9a-f]{64})$/m)
  return m?.[1] ?? null
}

/**
 * The ceiling on the community band, defined ONCE.
 *
 * The ingest enforced one number and the verifier asserted another, both
 * literals. Raising the ingest's alone would have silently truncated against a
 * stale gate; raising the gate's alone would have let an oversized snapshot
 * through. Nothing in the type system connected them.
 */
export const COMMUNITY_SNAPSHOT_CAP = 400
