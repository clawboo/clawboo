#!/usr/bin/env node
/**
 * Post-build guard: the marketplace catalog chunk must exist, and the entry must NOT
 * preload it.
 *
 * The companion unit test (`apps/web/src/features/layout/__tests__/entryImportGraph.test.ts`)
 * walks the source import graph; this checks what Rollup actually emitted. Both are
 * needed, because a `manualChunks` entry gives the catalog a stable NAME whether or not
 * it is deferred: if anything on the eager path regains a static import of it, Rollup
 * makes it a static dependency of the entry and Vite writes a `<link rel="modulepreload">`
 * for it into index.html. The build still "looks split" while every dashboard load
 * downloads 4 MB. That is the failure mode of PR #94 — see issue #83.
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

/** The chunk name assigned in apps/web/vite.config.ts `manualChunks`. */
const CHUNK = 'marketplace-catalog'
const CHUNK_FILE = new RegExp(`^${CHUNK}-[\\w-]+\\.js$`)

const fail = (msg) => {
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

if (!statSync(INDEX_HTML, { throwIfNoEntry: false })?.isFile()) {
  fail(
    `${path.relative(REPO_ROOT, INDEX_HTML)} not found — run \`pnpm build\` (or ` +
      '`pnpm --filter @clawboo/web build:ui`) before this check.',
  )
}

const html = readFileSync(INDEX_HTML, 'utf8')

// index.html existing does not prove assets/ does — a changed `build.assetsDir` or a
// half-finished build removes it, and a raw ENOENT stack would replace every
// actionable message below with a trace.
if (!statSync(ASSETS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
  fail(
    `${path.relative(REPO_ROOT, ASSETS_DIR)} not found — the build emitted no assets\n` +
      '   directory. Check `build.assetsDir` in apps/web/vite.config.ts, or re-run the build.',
  )
}

const assets = readdirSync(ASSETS_DIR)

// 1. The chunk exists — i.e. the manualChunks rule still matches something. If the
//    catalog directories are renamed and nobody updates vite.config.ts, the data
//    silently folds back into whichever chunk imports it.
const chunks = assets.filter((f) => CHUNK_FILE.test(f))
if (chunks.length === 0) {
  fail(
    `No \`${CHUNK}-*.js\` chunk in ${path.relative(REPO_ROOT, ASSETS_DIR)}.\n` +
      '   The manualChunks rule in apps/web/vite.config.ts no longer matches the catalog\n' +
      '   (renamed directory?), so the ~4.4 MB of data is folding into another chunk.',
  )
}

// 2. Nothing preloads it. Vite emits `<link rel="modulepreload">` for every chunk the
//    entry statically depends on, so a hit here means the catalog is back on the boot
//    path even though it has its own file.
const preloadTags = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]*>/g)].map((m) => m[0])

// Guard the guard: check 2 below is "no preload tag names the catalog", which passes
// trivially if there are no preload tags at all — as would happen under
// `build.modulePreload: false`, or if Vite changed the emitted markup. Either way the
// check would silently stop meaning anything, so require at least one tag to exist.
if (preloadTags.length === 0) {
  fail(
    'index.html has no <link rel="modulepreload"> tags at all, so the preload check\n' +
      '   below cannot prove anything. Either `build.modulePreload` was disabled in\n' +
      '   apps/web/vite.config.ts, or Vite changed its output. Re-establish an\n' +
      "   equivalent assertion (e.g. inspect the entry chunk's static imports) before\n" +
      '   trusting this script again.',
  )
}

// The build uses a RELATIVE base (`./assets/…`) so one bundle serves from any
// mount point; accept the absolute spelling too in case that changes back.
const preloadedAll = preloadTags
  .map((tag) => /href="(?:\.\/|\/)assets\/([^"]+)"/.exec(tag)?.[1] ?? tag)
  .map((href) => href.replace(/-[\w-]{8}\.js$/, '.js'))
const preloaded = preloadTags.filter((tag) => tag.includes(CHUNK))
if (preloaded.length > 0) {
  fail(
    `index.html preloads the ${CHUNK} chunk — it is on the boot path again:\n` +
      preloaded.map((t) => `     ${t}`).join('\n') +
      '\n\n   Something on the eager path regained a STATIC import of\n' +
      '   features/marketplace/{agents,teams}. A named chunk is not the same as a\n' +
      '   deferred one. Run the unit guard for the offending import chain:\n' +
      '     pnpm --filter @clawboo/web exec vitest run src/features/layout/__tests__/entryImportGraph.test.ts',
  )
}

const kb = (f) => Math.round(statSync(path.join(ASSETS_DIR, f)).size / 1024)

// Read the entry from the script tag rather than matching `index-*.js`: several app
// modules are named index.ts and emit chunks matching that pattern too.
const entry = /<script[^>]+type="module"[^>]*\ssrc="(?:\.\/|\/)assets\/([^"]+)"/.exec(html)?.[1]

console.log('\n✅ Marketplace catalog is a deferred chunk, not preloaded by the entry.')
for (const f of chunks) console.log(`   ${f} — ${kb(f)} KB (fetched on demand)`)
if (entry) console.log(`   ${entry} — ${kb(entry)} KB (entry)`)
console.log(`   entry preloads: ${preloadedAll.join(', ') || 'nothing'}`)
console.log()
