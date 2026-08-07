#!/usr/bin/env tsx
/**
 * Verify the committed marketplace catalog against its committed integrity
 * manifest — OFFLINE. Makes no network calls.
 *
 * This is the gate on the release path (`.github/workflows/publish.yml`) and on
 * every PR (`.github/workflows/ci.yml`). Because it never reaches upstream, an
 * upstream repo being renamed, force-pushed, or simply unavailable can no longer
 * hold up a release.
 *
 * It proves the 20 generated catalog files are exactly what the last
 * `pnpm ingest:marketplace` produced, and that the pinned SHAs recorded in the
 * manifest still match the constants in `lib/ingest-helpers.ts`. It does NOT prove
 * the catalog matches upstream — that is `pnpm verify:ingest`, which re-derives
 * from the pinned commits and runs weekly plus on any PR touching ingest.
 *
 * Exits 0 when everything matches; exits 1 otherwise.
 *
 * Usage: pnpm verify:catalog
 */

import {
  CATALOG_FILE_COUNT,
  MANIFEST_PATH,
  catalogFilePaths,
  describeSources,
  expectedSources,
  hashCatalogFile,
  readManifest,
  repoRelativePosix,
} from './lib/ingest-manifest.js'

const REGENERATE = 'Run `pnpm ingest:marketplace` to regenerate the catalog and manifest.'

async function main(): Promise<void> {
  console.log('\n🔍 Clawboo marketplace verify-catalog (offline — no upstream fetch)')
  console.log(`   Manifest: ${repoRelativePosix(MANIFEST_PATH)}\n`)

  // 1. The manifest exists, parses, and is a version we understand. A failure here
  //    is fatal — there is nothing left to check against.
  const manifest = await readManifest()

  const failures: string[] = []

  // 2. The recorded pins still match the SHA constants. This catches the most
  //    likely real failure: a SHA bumped in `ingest-helpers.ts` without a regen.
  const expected = expectedSources()
  let sourcesDiffer = false
  if (describeSources(manifest.sources) !== describeSources(expected)) {
    sourcesDiffer = true
    failures.push(
      '  ❌ pinned sources differ from `scripts/lib/ingest-helpers.ts`\n' +
        `  - manifest: ${describeSources(manifest.sources)}\n` +
        `  + constants: ${describeSources(expected)}\n` +
        `    ${REGENERATE} A pin bump changes the CONTENT, so re-hashing alone\n` +
        '    (`pnpm ingest:manifest`) is not a fix — it refuses to run across a pin change.',
    )
  } else {
    console.log(`  ✓ pinned sources (${describeSources(expected)})`)
  }

  // 3. The manifest covers exactly the generated file set — both directions, so a
  //    newly generated file that nobody added and a stale leftover both surface.
  const paths = catalogFilePaths()
  const expectedKeys = new Set(paths.map(repoRelativePosix))
  const manifestKeys = new Set(Object.keys(manifest.files))

  const missing = [...expectedKeys].filter((k) => !manifestKeys.has(k)).sort()
  const extra = [...manifestKeys].filter((k) => !expectedKeys.has(k)).sort()
  if (missing.length > 0) {
    failures.push(
      `  ❌ ${missing.length} generated file(s) absent from the manifest:\n` +
        missing.map((k) => `      ${k}`).join('\n') +
        `\n    ${REGENERATE}`,
    )
  }
  if (extra.length > 0) {
    failures.push(
      `  ❌ ${extra.length} manifest entr(y|ies) no longer generated:\n` +
        extra.map((k) => `      ${k}`).join('\n') +
        `\n    ${REGENERATE}`,
    )
  }
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ✓ manifest covers all ${expectedKeys.size} generated files`)
  }

  // 4. The tripwire in `ingest-helpers.ts`. If someone adds a generated file, both
  //    verifiers need updating and this is the reminder.
  if (paths.length !== CATALOG_FILE_COUNT) {
    failures.push(
      `  ❌ catalogFilePaths() returned ${paths.length} paths, expected ${CATALOG_FILE_COUNT}\n` +
        '    Update CATALOG_FILE_COUNT in `scripts/lib/ingest-helpers.ts` and make sure\n' +
        '    `scripts/verify-ingest.ts` re-derives the new file too.',
    )
  }

  // 5. Every file is present and hashes to what the manifest recorded.
  for (const absPath of paths) {
    const key = repoRelativePosix(absPath)
    const recorded = manifest.files[key]
    if (recorded === undefined) continue // already reported by check 3

    let actual: string
    try {
      actual = await hashCatalogFile(absPath)
    } catch (err) {
      const kind = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'FILE MISSING' : 'UNREADABLE'
      failures.push(`  ❌ ${key}: ${kind}\n    ${REGENERATE}`)
      continue
    }

    if (actual !== recorded) {
      failures.push(
        `  ❌ ${key}: checksum differs\n` +
          `  - manifest: ${recorded.slice(0, 12)}…\n` +
          `  + on disk:  ${actual.slice(0, 12)}…`,
      )
    } else {
      console.log(`  ✓ ${key}`)
    }
  }

  if (failures.length > 0) {
    console.error('\n\nCatalog integrity check failed:\n')
    for (const f of failures) console.error(f)
    // The re-bless path is deliberately NOT offered when the pins moved: re-hashing
    // would record the new pin against content generated from the old one, turning
    // this gate green on a catalog that does not match it.
    const rebless = sourcesDiffer
      ? ''
      : '  · Nothing changed but a tooling bump moved the canonical form (e.g. a Prettier major)?\n' +
        '      → `pnpm ingest:manifest` to re-bless, and say so in the commit message.\n'
    console.error(
      '\nThe generated catalog files are AUTO-GENERATED and must not be hand-edited.\n' +
        '  · Content changed on purpose (e.g. a pinned SHA bump)?\n' +
        '      → `pnpm ingest:marketplace`, then commit the regenerated files + manifest.\n' +
        rebless +
        '  · Unsure whether the catalog still matches upstream?\n' +
        '      → `pnpm verify:ingest` (needs network) re-derives it from the pinned commits.\n',
    )
    process.exit(1)
  }

  console.log(`\n✅ All ${paths.length} generated catalog files match the integrity manifest`)
  console.log(
    '   (clawboo/builtin.ts, clawboo/index.ts, teams/clawboo-builtin.ts, teams/index.ts are\n' +
      '    hand-written — not generated, so not covered here either)\n',
  )
}

main().catch((err) => {
  console.error('\n❌ Verify failed:', (err as Error).message)
  process.exit(1)
})
