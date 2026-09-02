// Guards the SPA's import graph: the marketplace catalog must stay out of the
// bundle entirely, not merely off the entry chunk.
//
// Why a test and not just a code review: PR #94 made `MarketplacePanel` lazy and added
// vendor `manualChunks`, and the catalog still shipped in the entry chunk because
// `WelcomeState → CreateTeamModal → teamCatalog → agents` was a four-hop TRANSITIVE
// static chain, with every hop individually reasonable. Nothing in review or in the
// build output flagged it. This walks the graph the bundler walks, so the same class of
// regression fails loudly instead of silently costing every dashboard load 4 MB of
// parse work. See issue #83 and features/teams/CreateTeamModalLazy.tsx.
//
// Parsed with the TypeScript compiler API rather than a regex: the catalog data files
// embed literal `import … from '…'` lines inside template literals (verbatim upstream
// markdown), which a regex walker would happily follow.

import * as fs from 'node:fs'
import * as path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_DIR = path.resolve(__dirname, '../../..')
const ENTRY = path.join(SRC_DIR, 'main.tsx')

/**
 * The generated seed: the ONE catalog data module in the bundle.
 *
 * The corpus directories this used to name (`features/marketplace/agents/`,
 * `features/marketplace/teams/`) no longer exist — the catalog is JSON packs
 * under `catalog/`, outside `src/` and outside the npm tarball. So there is no
 * corpus in the module graph left to police, and the rule that replaces it is
 * the one that can still be violated: the seed is the only catalog DATA seam,
 * `catalogClient.ts` is the only catalog FETCH seam, and the seed stays small.
 */
const SEED_DIR = 'features/marketplace/seed/'
const SEED_BARREL = 'src/features/marketplace/seed/index.ts'
const SEED_DATA = 'src/features/marketplace/seed/packs.ts'

/**
 * The seed is compiled into every install, so its bytes are paid whether or not
 * anyone opens the marketplace. `scripts/catalog/budget.mjs` enforces the same
 * ceiling on the built artifact; this catches it in the suite that runs first.
 */
const SEED_MAX_BYTES = 128 * 1024

/** Non-code imports (`main.tsx` pulls `./app/globals.css`). */
const ASSET_EXTENSIONS = [
  '.css',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.json',
  '.woff2',
]

/** Extension-less specifiers resolve against these, first match wins. */
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']

const toPosix = (p: string): string => p.split(path.sep).join('/')
const rel = (p: string): string => `src/${toPosix(path.relative(SRC_DIR, p))}`

/**
 * Static module specifiers only. A dynamic `import()` is a CallExpression rather than
 * a top-level ImportDeclaration, so it is excluded structurally — which is the whole
 * point. (`ts.preProcessFile` conflates the two; don't use it.)
 *
 * Type-only edges are skipped, since they are erased at build time. A plain
 * `import { SomeType }` is deliberately still counted: `verbatimModuleSyntax` is off,
 * so whether the transformer elides it is an implementation detail — not something to
 * bet a 4 MB chunk on. The fix is to write `import type`.
 */
function staticImportsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const specifiers: string[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause?.isTypeOnly) continue
      // `import { type A, type B } from '…'` — every binding erased.
      if (
        clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((e) => e.isTypeOnly)
      )
        continue
      // A clause-less `import './x'` is a real side-effect edge — keep it.
      if (ts.isStringLiteral(statement.moduleSpecifier))
        specifiers.push(statement.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue
      if (ts.isStringLiteral(statement.moduleSpecifier))
        specifiers.push(statement.moduleSpecifier.text)
    }
  }
  return specifiers
}

/** `null` = intentionally ignored (bare package or asset). Throws when unresolvable. */
function resolve(specifier: string, fromFile: string): string | null {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  const isAliased = specifier.startsWith('@/')
  // Bare specifiers are packages — nothing under packages/ or node_modules reaches
  // the web app's marketplace catalog, so they are not worth walking.
  if (!isRelative && !isAliased) return null
  if (ASSET_EXTENSIONS.some((ext) => specifier.endsWith(ext))) return null

  const base = isAliased
    ? path.join(SRC_DIR, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier)

  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }

  // Failing here is deliberate: silently dropping an unresolvable specifier is how a
  // guard like this rots into a no-op after a rename.
  throw new Error(`${rel(fromFile)}: cannot resolve '${specifier}'`)
}

/** BFS the static graph from `main.tsx`, remembering how each module was reached. */
function walkEagerGraph(): { reached: Set<string>; parent: Map<string, string> } {
  const reached = new Set<string>([ENTRY])
  const parent = new Map<string, string>()
  const queue = [ENTRY]

  while (queue.length > 0) {
    const file = queue.shift()!
    for (const specifier of staticImportsOf(file)) {
      const target = resolve(specifier, file)
      if (target === null || reached.has(target)) continue
      reached.add(target)
      parent.set(target, file)
      queue.push(target)
    }
  }
  return { reached, parent }
}

function chainTo(file: string, parent: Map<string, string>): string {
  const chain = [file]
  for (let at = parent.get(file); at !== undefined; at = parent.get(at)) chain.unshift(at)
  return chain.map((f, i) => `${i === 0 ? '  ' : '   → '}${rel(f)}`).join('\n')
}

/** Called only when there IS an offender — builds the shortest chain to the first. */
function explain(offenders: string[], parent: Map<string, string>, what: string): string {
  const first = offenders[0]!
  return [
    `Eager import of ${what} from the SPA entry (${offenders.length} module(s) reachable).`,
    '',
    chainTo(first, parent),
    '',
    'The catalog is JSON packs under catalog/, fetched at runtime through',
    '`features/marketplace/catalogClient.ts`. Only the small generated seed is',
    'compiled in, and only the lazy marketplace surfaces may reach it.',
    'If the import is types-only, write `import type`: it is not counted then.',
    'See catalog/README.md and issue #83.',
  ].join('\n')
}

describe('SPA eager import graph', () => {
  const { reached, parent } = walkEagerGraph()
  const reachedRel = [...reached].map(rel)

  it('walks a plausible share of the app (guards against a vacuous pass)', () => {
    // 159 modules today. A resolution bug that stops the walk early would otherwise
    // report "no offenders" and pass while checking nothing — and that failure mode is
    // catastrophic (single digits), not marginal, so the floor has real slack.
    expect(reached.size).toBeGreaterThan(120)
  })

  it('never reaches the compiled catalog seed', () => {
    const offenders = [...reached].filter((f) => toPosix(f).includes(SEED_DIR))
    // Thrown rather than passed as an `expect` message: vitest evaluates that message
    // eagerly, and building the chain needs an offender to exist.
    if (offenders.length > 0) throw new Error(explain(offenders, parent, 'the catalog seed'))
    expect(offenders).toEqual([])
  })

  it('does not reach features/marketplace at all', () => {
    // Tighter than the rule above and true today — it catches a creeping re-entry one
    // hop before the data itself. If a genuinely small, catalog-free marketplace module
    // ever needs to be eager, relax THIS assertion, never the one above.
    const offenders = [...reached].filter((f) => toPosix(f).includes('features/marketplace/'))
    if (offenders.length > 0) throw new Error(explain(offenders, parent, 'features/marketplace'))
    expect(offenders).toEqual([])
  })

  it('actually follows the chain that used to leak the catalog', () => {
    // A positive control. The three assertions above all pass if the walker simply
    // fails to walk, and the size floor only catches a total collapse. This pins the
    // exact route that leaked before #83 — main.tsx → App → ContentArea → WelcomeState
    // → the lazy wrapper — so the guard is proven to traverse `@/` aliases, relative
    // specifiers and barrels right up to the boundary it is policing.
    expect(reachedRel).toContain('src/features/layout/WelcomeState.tsx')
    expect(reachedRel).toContain('src/features/teams/CreateTeamModalLazy.tsx')
    // ...and stops there: the wrapper reaches the modal only through a dynamic import.
    expect(reachedRel).not.toContain('src/features/teams/CreateTeamModal.tsx')
  })
})

// ─── The permanent rule ──────────────────────────────────────────────────────
//
// The reachability tests above are a FLOOR, not a ceiling: they prove the eager
// path does not reach the seed, which stays true the moment someone moves an
// import behind a lazy boundary.
//
// The rule that replaces the old corpus walk is about SEAMS. There are exactly
// two ways app code may obtain catalog data:
//
//   `features/marketplace/seed`         the compiled builtin pack (offline)
//   `features/marketplace/catalogClient` everything else, fetched at runtime
//
// Anything else — a second generated data module, a fixture that grew into a
// catalog, a direct import of `seed/packs.ts` past its barrel — is how the
// megabytes come back. This walks EVERY file under src/, statically and
// dynamically, and names the ones that reach the seed data module directly.

/** Modules allowed to import the generated seed DATA rather than its barrel. */
const SEED_DATA_ALLOWLIST = [SEED_BARREL, 'src/features/layout/__tests__/entryImportGraph.test.ts']

/** The seam modules themselves, which are expected to import the seed barrel. */
const SEED_CONSUMERS = [
  'src/features/marketplace/catalogClient.ts',
  'src/features/marketplace/useCatalog.ts',
]

function* allSourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      yield* allSourceFiles(full)
    } else if (/\.tsx?$/.test(entry.name)) {
      yield full
    }
  }
}

/** Dynamic `import()` specifiers, which `staticImportsOf` deliberately excludes. */
function dynamicImportsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return out
}

describe('the marketplace has exactly two data seams', () => {
  const seedImporters: string[] = []
  const dataImporters: string[] = []
  for (const file of allSourceFiles(SRC_DIR)) {
    const relPath = rel(file)
    if (relPath === SEED_BARREL || relPath === SEED_DATA) continue
    for (const specifier of [...staticImportsOf(file), ...dynamicImportsOf(file)]) {
      const resolved = resolve(specifier, file)
      if (!resolved) continue
      const target = rel(resolved)
      if (target === SEED_DATA && !SEED_DATA_ALLOWLIST.includes(relPath)) {
        dataImporters.push(`${relPath} -> ${specifier}`)
      }
      if (target === SEED_BARREL) seedImporters.push(relPath)
    }
  }

  it('routes every seed read through the barrel, never the generated data module', () => {
    expect(dataImporters).toEqual([])
  })

  it('keeps the seed behind the fetch layer, which is the only other seam', () => {
    // The seed is the OFFLINE half of the catalog. If a card, a grid or a panel
    // starts reading it directly, the fetched half stops being authoritative and
    // the two drift.
    expect([...new Set(seedImporters)].sort()).toEqual(SEED_CONSUMERS)
  })

  // Positive control: the rule above passes trivially if the fetch layer was
  // deleted and every surface went back to importing data under a name this
  // walker does not recognise.
  it('has a fetch layer that the browse surfaces actually use', () => {
    const client = path.join(SRC_DIR, 'features/marketplace/catalogClient.ts')
    expect(fs.existsSync(client), 'catalogClient.ts must exist').toBe(true)
    const panel = fs.readFileSync(
      path.join(SRC_DIR, 'features/marketplace/MarketplacePanel.tsx'),
      'utf8',
    )
    expect(panel).toContain('useCatalogIndex')
  })

  it('keeps the compiled seed under its byte budget', () => {
    const bytes = [SEED_BARREL, SEED_DATA].reduce(
      (n, f) => n + fs.statSync(path.join(SRC_DIR, f.replace(/^src\//, ''))).size,
      0,
    )
    expect(
      bytes,
      `the seed is ${Math.round(bytes / 1024)} KB. It is the builtin pack and nothing ` +
        `else — check catalog.config.json \`seed\`.`,
    ).toBeLessThan(SEED_MAX_BYTES)
  })
})
