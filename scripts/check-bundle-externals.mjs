#!/usr/bin/env node
/**
 * scripts/check-bundle-externals.mjs
 *
 * Gate: every module the shipped CLI bundle still loads from node_modules must
 * be resolvable from a user's install.
 *
 * The tsup bundles inline nearly everything, so what survives as a bare
 * `require(...)` / `import(...)` in `dist/*.js` is the CLI's REAL runtime
 * dependency closure. This asserts that closure is a subset of:
 *
 *   • the package's declared `dependencies`
 *   • Node builtins
 *   • the documented optional externals (see `OPTIONAL_EXTERNALS`)
 *
 * Anything else resolves today only because the repo's workspace `node_modules`
 * sits above the bundle — and would be `ERR_MODULE_NOT_FOUND` on `npx clawboo`.
 *
 * Usage:
 *   node scripts/check-bundle-externals.mjs [packageDir]
 *
 * `packageDir` defaults to `apps/cli` (the repo build). The clean-install smoke
 * test points it at the INSTALLED tarball instead, which is the check that
 * actually proves the published `files` whitelist + dependency closure.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeBundleExternals, selfCheckExtractor } from './lib/bundle-externals.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

/**
 * The Node-executed entry points inside `dist/` (the UI assets are browser code
 * and never `require` anything).
 *
 * Derived from the manifest's own `bin` map plus `dist/server.js` (forked by the
 * launcher, so not a bin), unioned with anything else under `dist/bin/`. Reading
 * `bin` means a newly published entry point is covered the day it is added, and
 * a `bin` target the tarball forgot shows up here as a missing file.
 */
async function bundleEntryPoints(packageDir, pkg) {
  const bin = pkg.bin ?? {}
  const declared = typeof bin === 'string' ? [bin] : Object.values(bin)
  const rels = new Set([...declared, 'dist/server.js'])
  try {
    for (const file of await fs.readdir(path.join(packageDir, 'dist', 'bin'))) {
      if (file.endsWith('.js')) rels.add(`dist/bin/${file}`)
    }
  } catch {
    /* a missing dist/bin surfaces as the declared bin targets going missing */
  }
  return [...rels].sort().map((rel) => path.join(packageDir, rel))
}

/**
 * Analyze one package directory (must contain `package.json` + `dist/`).
 *
 * @param {{ packageDir: string, log?: (msg: string) => void }} opts
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
export async function checkBundleExternals({ packageDir, log = () => {} }) {
  const errors = []

  const scannerFailures = selfCheckExtractor()
  if (scannerFailures.length > 0) {
    // The extractor is the thing doing the asserting — if it is broken, every
    // downstream verdict is meaningless. Fail here rather than report a green.
    return {
      ok: false,
      errors: [
        'the bundle-externals extractor failed its own fixtures — fix scripts/lib/bundle-externals.mjs:',
        ...scannerFailures.map((f) => `  • ${f}`),
      ],
    }
  }
  log('extractor self-check passed')

  const pkgPath = path.join(packageDir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
  } catch (err) {
    // Everything else here reports through { ok, errors }; a throw would surface
    // as a bare stack from the smoke test's outer catch, which is the opposite
    // of what a gate whose job is naming packaging defects should do.
    return {
      ok: false,
      errors: [
        ...errors,
        `cannot read ${pkgPath}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }
  }
  const dependencies = Object.keys(pkg.dependencies ?? {})
  log(`analyzing ${pkg.name}@${pkg.version} at ${packageDir}`)

  const files = []
  for (const file of await bundleEntryPoints(packageDir, pkg)) {
    let source
    try {
      source = await fs.readFile(file, 'utf8')
    } catch {
      errors.push(`missing bundle entry point: ${path.relative(packageDir, file)}`)
      continue
    }
    files.push({ label: path.relative(packageDir, file), source })
  }
  if (files.length === 0) {
    return {
      ok: false,
      errors: [...errors, `no bundle entry points found under ${path.join(packageDir, 'dist')}`],
    }
  }

  let result
  try {
    result = analyzeBundleExternals({ files, dependencies })
  } catch (err) {
    return { ok: false, errors: [...errors, err instanceof Error ? err.message : String(err)] }
  }

  log(
    `scanned ${files.length} bundle(s): ${result.declared.length} declared, ` +
      `${result.builtins.length} builtin, ${result.optional.length} documented-optional, ` +
      `${result.relative.length} relative reference(s)`,
  )

  // A relative specifier inside a bundle points at a sibling file that must
  // have shipped. Resolving it here catches an `files`-whitelist gap that the
  // bare-specifier check cannot see.
  for (const rel of result.relative) {
    const from = path.dirname(path.join(packageDir, rel.file))
    const target = path.resolve(from, rel.specifier)
    // Cover every extension Node would try for a sibling the bundle loads. A
    // missing candidate here fabricates a failure against a file that shipped,
    // which is the one direction this tooling must never fail in.
    const candidates = [
      target,
      `${target}.js`,
      `${target}.cjs`,
      `${target}.mjs`,
      `${target}.json`,
      `${target}.node`,
      path.join(target, 'index.js'),
    ]
    let exists = false
    for (const candidate of candidates) {
      try {
        await fs.access(candidate)
        exists = true
        break
      } catch {
        /* try the next extension */
      }
    }
    if (!exists) {
      errors.push(
        `${rel.file} loads '${rel.specifier}', which does not exist in the package — ` +
          'the file was not included by the `files` whitelist',
      )
    }
  }

  for (const hit of result.optional) {
    log(`optional (documented in ${hit.entry.docs}): ${hit.specifier} — from ${hit.file}`)
  }

  const byPackage = new Map()
  for (const v of result.violations) {
    if (!byPackage.has(v.package)) byPackage.set(v.package, new Set())
    byPackage.get(v.package).add(`${v.file} → ${v.specifier}`)
  }
  for (const [pkgName, sites] of [...byPackage].sort(([a], [b]) => a.localeCompare(b))) {
    errors.push(
      `'${pkgName}' is loaded by the shipped bundle but is neither a declared dependency of ` +
        `${pkg.name} nor a documented optional external:\n` +
        [...sites]
          .sort()
          .map((s) => `      ${s}`)
          .join('\n') +
        `\n    Fix: declare '${pkgName}' in apps/cli/package.json "dependencies", force-bundle it ` +
        'via tsup `noExternal` (apps/web/tsup.server.config.ts), or add it to OPTIONAL_EXTERNALS ' +
        'in scripts/lib/bundle-externals.mjs with a documented degradation.',
    )
  }

  return { ok: errors.length === 0, errors }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const packageDir = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, 'apps/cli'))
  const { ok, errors } = await checkBundleExternals({
    packageDir,
    log: (msg) => console.log(`[bundle-externals] ${msg}`),
  })
  if (ok) {
    console.log('[bundle-externals] ✓ every external the bundle loads is declared or documented.')
  } else {
    for (const err of errors) console.error(`[bundle-externals] FAIL: ${err}`)
    process.exitCode = 1
  }
}
