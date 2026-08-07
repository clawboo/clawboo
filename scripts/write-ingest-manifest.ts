#!/usr/bin/env tsx
/**
 * Re-bless the marketplace catalog integrity manifest from the files already on
 * disk — offline, no upstream fetch.
 *
 * ⚠ This is NOT the way to fix a `pnpm verify:catalog` failure. If the catalog
 * content changed, the fix is `pnpm ingest:marketplace` (which regenerates the
 * files from the pinned upstream commits and rewrites the manifest as its last
 * step). Running this instead would silently bless whatever is on disk, including
 * a hand-edit of an AUTO-GENERATED file.
 *
 * Its one legitimate use is a TOOLING-driven change to the canonical form with no
 * content change — a Prettier major bump being the realistic case. Without it, a
 * purely local tooling change would force a run of the network-bound generator,
 * re-coupling the repo to upstream availability.
 *
 * Usage: pnpm ingest:manifest
 */

import * as path from 'node:path'

import {
  MANIFEST_PATH,
  describeSources,
  expectedSources,
  readManifest,
  writeManifest,
} from './lib/ingest-manifest.js'

async function main(): Promise<void> {
  // GUARD: refuse to re-bless across a pin change.
  //
  // Without this, bumping a SHA constant and running `pnpm ingest:manifest` would
  // rewrite the recorded pin to the NEW commit while every file hash still describes
  // content generated from the OLD one — and `pnpm verify:catalog` would then go
  // green on a catalog that does not match its own pin. That is the one way this
  // script could silently defeat the gate it exists to serve, so it is a hard error.
  //
  // The legitimate case — a tooling bump moving the canonical form with the pins
  // unchanged — passes straight through.
  const current = await readManifest()
  const expected = expectedSources()
  if (describeSources(current.sources) !== describeSources(expected)) {
    console.error(
      '\n❌ Refusing to re-bless the manifest: the pinned sources changed.\n\n' +
        `   manifest:  ${describeSources(current.sources)}\n` +
        `   constants: ${describeSources(expected)}\n\n` +
        '   A pin bump means the CONTENT must be regenerated from the new commit, not\n' +
        '   just re-hashed. Run `pnpm ingest:marketplace` (it rewrites the manifest as\n' +
        '   its last step). This script is only for a tooling-driven change to the\n' +
        '   canonical form — e.g. a Prettier major — with the pins untouched.\n',
    )
    process.exit(1)
  }

  const count = await writeManifest()
  console.log(
    `✅ Wrote ${path.relative(process.cwd(), MANIFEST_PATH)} (${count} file checksums)\n` +
      '   Review the diff: a change here with no catalog change means the canonical\n' +
      '   form moved (e.g. a Prettier bump). A change alongside catalog edits means\n' +
      '   you probably wanted `pnpm ingest:marketplace` instead.',
  )
}

main().catch((err) => {
  console.error('\n❌ Manifest write failed:', err)
  process.exit(1)
})
