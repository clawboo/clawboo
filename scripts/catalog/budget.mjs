#!/usr/bin/env node
/**
 * Byte budgets for the two artifacts a user actually downloads.
 *
 * THE SEED is compiled into the bundle, so its bytes are paid by every install
 * whether or not anyone opens the marketplace. It exists to keep first-run
 * onboarding working offline, and nothing else belongs in it: the moment a
 * second pack is seeded "just in case", the 4.2 MB is back in the tarball.
 *
 * THE INDEX is one fetch shared by every browse surface. Its ceiling is the
 * regression tripwire for the split itself: putting a body field back onto an
 * index row pushes it past the budget immediately, long before anyone notices
 * the page got slower.
 *
 * Plain `.mjs`, matching `scripts/check-entry-chunk.mjs`: this runs in CI right
 * after the artifacts are built and has no reason to pay for a TS transform.
 *
 * Usage: node scripts/catalog/budget.mjs
 */

import { readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const SEED_FILES = [
  'apps/web/src/features/marketplace/seed/packs.ts',
  'apps/web/src/features/marketplace/seed/index.ts',
]
const SERVER_SEED = 'apps/web/server/lib/catalogSeed.ts'

const SEED_MAX_BYTES = 128 * 1024
const INDEX_MAX_BYTES = 512 * 1024

const fail = (msg) => {
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const sizeOf = (rel) => {
  const stat = statSync(path.join(REPO_ROOT, rel), { throwIfNoEntry: false })
  if (!stat?.isFile()) fail(`${rel} not found. Run \`pnpm catalog:build\`.`)
  return stat.size
}

const config = JSON.parse(readFileSync(path.join(REPO_ROOT, 'catalog/catalog.config.json'), 'utf8'))
const indexRel = `catalog/dist/${config.dist}/index.json`

const spaSeed = SEED_FILES.reduce((n, f) => n + sizeOf(f), 0)
const serverSeed = sizeOf(SERVER_SEED)
const indexBytes = sizeOf(indexRel)

for (const [label, bytes] of [
  ['the SPA seed', spaSeed],
  ['the server seed', serverSeed],
]) {
  if (bytes > SEED_MAX_BYTES) {
    fail(
      `${label} is ${kb(bytes)}, over the ${kb(SEED_MAX_BYTES)} budget.\n` +
        '   The seed is the builtin pack and nothing else - it ships in every install\n' +
        '   so that first-run onboarding works offline. Everything else is fetched.\n' +
        '   Check catalog.config.json `seed`, then re-run `pnpm catalog:build`.',
    )
  }
}

if (indexBytes > INDEX_MAX_BYTES) {
  fail(
    `${indexRel} is ${kb(indexBytes)}, over the ${kb(INDEX_MAX_BYTES)} browse budget.\n` +
      '   A body field (files / workflowNarrative / routing) has almost certainly been\n' +
      '   added back to an index row. Index rows are what the CARDS render; bodies live\n' +
      '   in the pack bundles and are fetched on demand.',
  )
}

console.log('\n✅ Catalog budgets')
console.log(`   SPA seed      - ${kb(spaSeed)} / ${kb(SEED_MAX_BYTES)}`)
console.log(`   server seed   - ${kb(serverSeed)} / ${kb(SEED_MAX_BYTES)}`)
console.log(`   ${indexRel} - ${kb(indexBytes)} / ${kb(INDEX_MAX_BYTES)}`)
console.log()
