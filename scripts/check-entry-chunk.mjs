#!/usr/bin/env node
/**
 * Post-build guard on `dist/ui`: the builtin SEED must be in the bundle, the
 * rest of the catalog must not be, and nothing large may sit on the boot path.
 *
 * HISTORY, because this file has asserted three different things. The catalog
 * was once a named `marketplace-catalog` Rollup chunk and this script asserted
 * the chunk existed and was not preloaded (issue #83: a manual chunk an eager
 * import still reached became a modulepreload of the entry, so the build looked
 * split while every dashboard load pulled ~4 MB). Then the catalog was emitted
 * into `public/catalog/` and copied verbatim into `dist/ui/catalog/`, and this
 * asserted on those files.
 *
 * Neither is true now. The catalog is JSON packs under `catalog/`, excluded from
 * the npm tarball and fetched at runtime; only the generated seed - the builtin
 * pack - is compiled in, and it is compiled in DELIBERATELY, because first-run
 * onboarding must work offline.
 *
 * So the sentinel check has two halves, and they are opposites:
 *
 *   PRESENT - a slice of a SEED body must appear in some emitted chunk. If it
 *     does not, the seed was tree-shaken or never imported, and a first run with
 *     no network has nothing to click (`SelectTeamStep` passes
 *     `allowStartFromScratch={false}`).
 *
 *   ABSENT  - a slice of a NON-SEED pack body must appear in NO emitted chunk.
 *     That is the proof the corpus is out of the JavaScript BY VALUE, so it
 *     survives a directory rename, a `manualChunks` rewrite, a Vite major, or
 *     any future splitting strategy. A name match could not see any of those.
 *
 * The companion unit test (`apps/web/src/features/layout/__tests__/entryImportGraph.test.ts`)
 * walks the source import graph; this checks what Rollup actually emitted.
 *
 * Usage: node scripts/check-entry-chunk.mjs   (after `pnpm build` / `pnpm --filter @clawboo/web build:ui`)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI_DIR = path.join(REPO_ROOT, 'apps/web/dist/ui')
const INDEX_HTML = path.join(UI_DIR, 'index.html')
const ASSETS_DIR = path.join(UI_DIR, 'assets')
const CATALOG_CONFIG = path.join(REPO_ROOT, 'catalog/catalog.config.json')
const SEED_FILES = [
  'apps/web/src/features/marketplace/seed/packs.ts',
  'apps/web/src/features/marketplace/seed/index.ts',
]

/**
 * The seed is compiled into every install, so its bytes are paid whether or not
 * anyone opens the marketplace. This replaces the old index-file budget, which
 * measured an artifact that is no longer in `dist/ui` at all.
 */
const SEED_MAX_BYTES = 128 * 1024
/** Nothing this large belongs on the boot path, whatever it is called. */
const PRELOAD_MAX_BYTES = 700 * 1024

/**
 * Chunks already over the budget when this check was introduced.
 *
 * `graph` is React Flow + elkjs (~1.5 MB) and the entry has preloaded it since
 * before the catalog split; verified by building the pre-split tree and diffing
 * index.html, which emits the same chunk hash.
 *
 * Listed rather than silently raising the ceiling: the budget still catches any
 * NEW oversized preload, and this entry is a standing invitation to make the
 * Ghost Graph lazy. Removing a name from this list should only ever be a fix.
 */
const KNOWN_LARGE_PRELOADS = ['graph']

const fail = (msg) => {
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

const rel = (p) => path.relative(REPO_ROOT, p)
const kb = (n) => `${Math.round(n / 1024)} KB`

if (!statSync(INDEX_HTML, { throwIfNoEntry: false })?.isFile()) {
  fail(
    `${rel(INDEX_HTML)} not found - run \`pnpm build\` (or ` +
      '`pnpm --filter @clawboo/web build:ui`) before this check.',
  )
}

const html = readFileSync(INDEX_HTML, 'utf8')

// index.html existing does not prove assets/ does - a changed `build.assetsDir` or a
// half-finished build removes it, and a raw ENOENT stack would replace every
// actionable message below with a trace.
if (!statSync(ASSETS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
  fail(
    `${rel(ASSETS_DIR)} not found - the build emitted no assets\n` +
      '   directory. Check `build.assetsDir` in apps/web/vite.config.ts, or re-run the build.',
  )
}

const jsChunks = readdirSync(ASSETS_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: f, text: readFileSync(path.join(ASSETS_DIR, f), 'utf8') }))
if (jsChunks.length === 0) fail(`${rel(ASSETS_DIR)} contains no .js chunks.`)

// -- The catalog, read from the repo (it is committed, not built here). ------
const config = JSON.parse(readFileSync(CATALOG_CONFIG, 'utf8'))
const DIST = path.join(REPO_ROOT, 'catalog/dist', config.dist)
const indexFile = path.join(DIST, 'index.json')
if (!statSync(indexFile, { throwIfNoEntry: false })?.isFile()) {
  fail(
    `${rel(indexFile)} not found.\n` +
      '   catalog/dist is COMMITTED. Run `pnpm catalog:build` and commit the result.',
  )
}
const catalogIndex = JSON.parse(readFileSync(indexFile, 'utf8'))

const bundleOf = (packRow) => {
  const relPath = packRow.path.startsWith(`${config.dist}/`)
    ? packRow.path.slice(config.dist.length + 1)
    : packRow.path
  return JSON.parse(readFileSync(path.join(DIST, relPath), 'utf8'))
}

const seedRow = (catalogIndex.packs ?? []).find(
  (p) => p.publisher === config.seed.publisher && p.slug === config.seed.slug,
)
const otherRows = (catalogIndex.packs ?? []).filter((p) => p !== seedRow)
if (!seedRow) fail(`${rel(indexFile)} has no row for the seed pack named in catalog.config.json.`)
if (otherRows.length === 0) {
  fail(
    'Every pack in the index IS the seed, so the "corpus is not bundled" half of this\n' +
      '   check would pass vacuously. Failing loudly instead.',
  )
}

/**
 * A 64-char slice with no quote, newline or backslash, so JSON/JS escaping
 * cannot hide it from a plain substring search in an emitted chunk.
 */
function sentinelFrom(bundle, label) {
  for (const body of Object.values(bundle.bodies?.agents ?? {})) {
    const identity = body.files?.['IDENTITY.md'] ?? ''
    for (let i = 0; i + 64 <= identity.length; i++) {
      const slice = identity.slice(i, i + 64)
      if (!/["\n\\]/.test(slice) && slice.trim().length === 64) return slice
    }
  }
  fail(
    `Could not derive a sentinel from ${label} - no IDENTITY.md in it has a 64-char\n` +
      '   run free of quotes, newlines and backslashes. The check would pass vacuously,\n' +
      '   so it is failing loudly instead.',
  )
}

// -- 1. THE SEED IS PRESENT. Proven by value, in an emitted chunk. -----------
const seedSentinel = sentinelFrom(bundleOf(seedRow), `the ${seedRow.id} pack`)
const carrying = jsChunks.filter((c) => c.text.includes(seedSentinel))
if (carrying.length === 0) {
  fail(
    'The builtin catalog seed is NOT in any emitted chunk.\n\n' +
      '   First-run onboarding renders with `allowStartFromScratch={false}`, so an\n' +
      '   install with no network and no seed has nothing to click. Something either\n' +
      '   dropped the import of `features/marketplace/seed` or tree-shook it away.\n' +
      '   Regenerate with `pnpm catalog:build` and re-run the build.',
  )
}

// -- 2. THE CORPUS IS ABSENT. The regression tripwire for the whole split. ---
const foreign = otherRows[0]
const corpusSentinel = sentinelFrom(bundleOf(foreign), `the ${foreign.id} pack`)
const leaking = jsChunks.filter((c) => c.text.includes(corpusSentinel)).map((c) => c.name)
if (leaking.length > 0) {
  fail(
    `Agent body prose from the "${foreign.id}" pack is inside emitted JavaScript:\n` +
      leaking.map((f) => `     ${f}`).join('\n') +
      '\n\n   Only the SEED may be compiled in. Everything else is fetched from\n' +
      '   /api/catalog/*. Run the import-graph guard to find the chain:\n' +
      '     pnpm --filter @clawboo/web exec vitest run src/features/layout/__tests__/entryImportGraph.test.ts',
  )
}

// -- 3. The seed byte budget, replacing the retired index-file budget. -------
const seedBytes = SEED_FILES.reduce((n, f) => {
  const stat = statSync(path.join(REPO_ROOT, f), { throwIfNoEntry: false })
  if (!stat?.isFile()) fail(`${f} not found. Run \`pnpm catalog:build\`.`)
  return n + stat.size
}, 0)
if (seedBytes > SEED_MAX_BYTES) {
  fail(
    `The compiled seed is ${kb(seedBytes)}, over the ${kb(SEED_MAX_BYTES)} budget.\n` +
      '   The seed is the builtin pack and nothing else - it exists so first-run\n' +
      '   onboarding works offline, not as a cache. Check `seed` in\n' +
      '   catalog/catalog.config.json, then re-run `pnpm catalog:build`.',
  )
}

// -- 4. Generic preload budget. ---------------------------------------------
const preloadTags = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]*>/g)].map((m) => m[0])

// Guard the guard: check 4 is "nothing huge is preloaded", which passes trivially if
// there are no preload tags at all - as would happen under `build.modulePreload: false`,
// or if Vite changed the emitted markup.
if (preloadTags.length === 0) {
  fail(
    'index.html has no <link rel="modulepreload"> tags at all, so the preload check\n' +
      '   below cannot prove anything. Either `build.modulePreload` was disabled in\n' +
      '   apps/web/vite.config.ts, or Vite changed its output. Re-establish an\n' +
      "   equivalent assertion (e.g. inspect the entry chunk's static imports) before\n" +
      '   trusting this script again.',
  )
}

// The build uses a RELATIVE base (`./assets/...`) so one bundle serves from any
// mount point; accept the absolute spelling too in case that changes back.
const preloadedFiles = preloadTags
  .map((tag) => /href="(?:\.\/|\/)assets\/([^"]+)"/.exec(tag)?.[1])
  .filter(Boolean)

const bytesOf = (f) => statSync(path.join(ASSETS_DIR, f), { throwIfNoEntry: false })?.size ?? 0
const isKnown = (f) => KNOWN_LARGE_PRELOADS.some((n) => f.startsWith(`${n}-`))
const oversized = preloadedFiles.filter((f) => bytesOf(f) > PRELOAD_MAX_BYTES && !isKnown(f))

// Guard the allowlist: an entry that no longer matches anything is stale, and a
// stale name silently widens the budget for whatever takes that prefix next.
const staleAllow = KNOWN_LARGE_PRELOADS.filter(
  (n) => !preloadedFiles.some((f) => f.startsWith(`${n}-`)),
)
if (staleAllow.length > 0) {
  fail(
    `KNOWN_LARGE_PRELOADS names chunks that are no longer preloaded: ${staleAllow.join(', ')}.\n` +
      '   If they were made lazy, delete them from the list in this file.',
  )
}
if (oversized.length > 0) {
  fail(
    `index.html preloads chunks over the ${PRELOAD_MAX_BYTES / 1024} KB boot budget:\n` +
      oversized.map((f) => `     ${f} - ${kb(bytesOf(f))}`).join('\n') +
      '\n\n   Something on the eager path gained a STATIC import of a large module.\n' +
      '   Find the chain with:\n' +
      '     pnpm --filter @clawboo/web exec vitest run src/features/layout/__tests__/entryImportGraph.test.ts',
  )
}

const entry = /<script[^>]+type="module"[^>]*\ssrc="(?:\.\/|\/)assets\/([^"]+)"/.exec(html)?.[1]

console.log('\n✅ Only the builtin seed ships in the bundle; no other pack prose is in any chunk.')
console.log(
  `   seed               - ${kb(seedBytes)} / ${kb(SEED_MAX_BYTES)}, in ${carrying.map((c) => c.name).join(', ')}`,
)
console.log(
  `   fetched at runtime - ${catalogIndex.counts.agents} agents, ${catalogIndex.counts.teams} teams ` +
    `across ${catalogIndex.packs.length} pack(s)`,
)
if (entry) console.log(`   entry              - ${kb(bytesOf(entry))} (${entry})`)
const preloadBytes = preloadedFiles.reduce((n, f) => n + bytesOf(f), 0)
const biggest = [...preloadedFiles].sort((a, b) => bytesOf(b) - bytesOf(a)).slice(0, 3)
console.log(
  `   entry preloads     - ${preloadedFiles.length} chunks, ${kb(preloadBytes)} total` +
    (biggest.length
      ? ` (largest: ${biggest.map((f) => `${f} ${kb(bytesOf(f))}`).join(', ')})`
      : ''),
)
console.log()
