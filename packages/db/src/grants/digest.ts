// sha256 over the canonical strings @clawboo/governance produces.
//
// The SPLIT is deliberate and documented at the top of governance/grants/
// canonical.ts: canonicalisation is pure string work and stays browser-safe so
// the SPA can compute the same string, while hashing needs node:crypto and lives
// here. Keeping them apart is what lets the graph and the server agree on what
// drift means without shipping a crypto polyfill to the browser.

import { createHash } from 'node:crypto'
import {
  canonicalizeSpec,
  canonicalizeToolSnapshot,
  type CanonicalizableSpec,
  type CanonicalizableTool,
} from '@clawboo/governance'

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** The digest stored in `connectors.spec_hash` and pinned by a grant. */
export function specDigest(spec: CanonicalizableSpec): string {
  return sha256Hex(canonicalizeSpec(spec))
}

/**
 * The digest stored in `connectors.tools_hash` and pinned by a grant.
 *
 * Covers tool DESCRIPTIONS as well as names, because a rug-pull that rewrites a
 * description to smuggle instructions changes nothing else. A hash over names
 * alone would miss the entire attack.
 */
export function toolsDigest(tools: readonly CanonicalizableTool[]): string {
  return sha256Hex(canonicalizeToolSnapshot(tools))
}
