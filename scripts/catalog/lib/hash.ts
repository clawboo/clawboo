// Canonical bytes for a catalog artifact, and the SRI digest over those bytes.
//
// THE HASHING RULE IS DELIBERATELY DIFFERENT FROM THE RETIRED INGEST MANIFEST,
// and it is written down here so nobody "fixes" it back.
//
// `scripts/lib/ingest-manifest.ts` (deleted) hashed the PRETTIER-CANONICAL form
// of its inputs. It had to: its inputs were TypeScript files that a pre-commit
// hook restyles, so hashing the raw bytes made every reflow look like a content
// change.
//
// A pack bundle has no formatter round-trip. It is generated, committed, fetched
// over HTTP, and verified byte-for-byte by a client that has never seen
// Prettier. So the canonical form here is the SPEC's own: keys sorted, no
// insignificant whitespace, LF, and NO trailing newline. Those exact bytes are
// what is written to disk, what is served, and what is hashed. Introducing a
// formatter anywhere in that chain would break every published integrity value.
//
// `.prettierignore` already ends with `dist/` and `**/dist/`, which match
// `catalog/dist/` under Prettier's gitignore-style semantics, so no new entry is
// needed to keep Prettier's hands off the emitted bytes.

import { createHash } from 'node:crypto'

/** A JSON value, spelled out so the canonicaliser can be total. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * Recursively sort object keys. Arrays keep their order: order is content for a
 * roster or a tag list, and re-sorting one would change what the pack means.
 */
function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {}
    for (const key of Object.keys(value).sort()) {
      const v = value[key]
      if (v === undefined) continue
      out[key] = sortKeys(v)
    }
    return out
  }
  return value
}

/**
 * The canonical serialization: sorted keys, no spaces, LF, no trailing newline.
 * These are the bytes that get written, served, and hashed.
 */
export function canonicalJson(value: unknown): string {
  // The round-trip drops `undefined` members and normalises anything with a
  // toJSON, so what is sorted is exactly what would be serialized.
  const plain = JSON.parse(JSON.stringify(value)) as Json
  return JSON.stringify(sortKeys(plain))
}

/** `sha256-<base64>`, the Subresource Integrity spelling. */
export function sriOf(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
}

/** Hex sha256, used for the on-disk cache filename (`~/.clawboo/catalog/<hex>.json`). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Canonical bytes plus their integrity value, computed over those exact bytes. */
export function canonicalWithIntegrity(value: unknown): {
  text: string
  integrity: string
  bytes: number
} {
  const text = canonicalJson(value)
  return { text, integrity: sriOf(text), bytes: Buffer.byteLength(text, 'utf8') }
}
