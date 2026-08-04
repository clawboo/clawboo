// Browser-bundle purity guard.
//
// `apps/web/src/**` is bundled into the Vite SPA. `@clawboo/db`'s barrel re-exports
// `src/db.ts`, which pulls better-sqlite3, drizzle-orm, and node:fs/os/path — so a
// single VALUE import from browser code would drag the whole server graph into the
// SPA. Type-only imports are fine: `isolatedModules` guarantees esbuild erases them,
// and four already exist (stores/cost, stores/approvals, approvals/useApprovalActions,
// connection/GatewayBootstrap).
//
// The board UI reads its status rules from @clawboo/board-core instead, which is why
// the second half of this file asserts that package's build output really is free of
// dependencies — the property that makes it safe to bundle.
//
// This is complementary to the lint-enforced layer boundaries (eslint.config.mjs +
// server/lib/__tests__/importBoundary.test.ts): those block RELATIVE imports across
// src/ ↔ server/, but say nothing about which BARE @clawboo/* specifiers are safe
// for the browser. That gap — a value import of the server-only db barrel — is what
// this test guards.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

// Drop comment trivia the LEXER way, so prose about an import can't trip the
// scanner. Regex stripping is not enough here: a string literal that merely
// CONTAINS a comment opener (an unpaired "slash-star", or any `src/**` glob
// pattern) would open a phantom block comment and swallow the executable code
// after it — hiding a real import. The TypeScript scanner tokenizes strings as
// strings and comments as trivia, so only genuine comments are removed; a URL's
// `//` inside a string survives untouched for the same reason.
function stripComments(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  )
  let out = ''
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
    if (t !== ts.SyntaxKind.SingleLineCommentTrivia && t !== ts.SyntaxKind.MultiLineCommentTrivia) {
      out += scanner.getTokenText()
    }
  }
  return out
}

const SPECIFIER = '@clawboo/db'

// Tempered match: the clause between the keyword and `from` may not contain another
// import/export, so each match anchors to its OWN statement rather than swallowing
// the one above it.
const STATIC_RE = new RegExp(
  String.raw`\b(import|export)\b((?:(?!\b(?:import|export)\b)[\s\S])*?)from\s*['"]` +
    SPECIFIER.replace('/', String.raw`\/`) +
    String.raw`['"]`,
  'g',
)
const DYNAMIC_RE = new RegExp(
  String.raw`\b(?:require|import)\s*\(\s*['"]` +
    SPECIFIER.replace('/', String.raw`\/`) +
    String.raw`['"]\s*\)`,
  'g',
)

/** The value imports of `@clawboo/db` in one file. Type-only imports are allowed. */
function valueImportsOfDb(source: string): string[] {
  const code = stripComments(source)
  const found: string[] = []
  for (const [whole, , clause] of code.matchAll(STATIC_RE)) {
    if (!/^\s*type\b/.test(clause)) found.push(whole.replace(/\s+/g, ' ').trim())
  }
  for (const [whole] of code.matchAll(DYNAMIC_RE)) found.push(whole.trim())
  return found
}

describe('no browser source value-imports @clawboo/db', () => {
  const files = sourceFiles(SRC)

  it('finds the browser sources (sanity — an empty sweep would pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('detects a value import, a re-export, and a dynamic import (the scanner works)', () => {
    expect(valueImportsOfDb(`import { createDb } from '${SPECIFIER}'`)).toHaveLength(1)
    expect(valueImportsOfDb(`export { createDb } from '${SPECIFIER}'`)).toHaveLength(1)
    expect(valueImportsOfDb(`const m = await import('${SPECIFIER}')`)).toHaveLength(1)
    // A type import preceded by another import must not be mis-attributed.
    expect(
      valueImportsOfDb(`import { a } from './a'\nimport type { B } from '${SPECIFIER}'`),
    ).toEqual([])
    expect(valueImportsOfDb(`// import { createDb } from '${SPECIFIER}'`)).toEqual([])
  })

  it('cannot be blinded by comment markers inside string literals', () => {
    // Regex-based stripping treated everything between these two strings as one
    // block comment and swallowed the import — the lexer must not.
    const open = '/' + '*'
    const close = '*' + '/'
    const trap = [
      `const a = '${open}'`,
      `import { createDb } from '${SPECIFIER}'`,
      `const b = '${close}'`,
    ].join('\n')
    expect(valueImportsOfDb(trap)).toHaveLength(1)
    // …while a genuine block comment still hides nothing worth flagging, and a
    // string containing `//` (a URL) survives stripping intact.
    expect(valueImportsOfDb(`/* import { createDb } from '${SPECIFIER}' */`)).toEqual([])
    expect(stripComments(`const u = 'https://claw.boo' // trailing note`)).toContain(
      'https://claw.boo',
    )
  })

  it('has no value import anywhere under apps/web/src', () => {
    const offenders: string[] = []
    for (const file of files) {
      for (const stmt of valueImportsOfDb(readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(SRC, file)}: ${stmt}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('@clawboo/board-core ships with no dependencies of its own', () => {
  const require_ = createRequire(import.meta.url)
  // The `require` condition resolves to dist/index.js; the browser bundler takes the
  // `import` condition, so check its ESM sibling too.
  const cjs = require_.resolve('@clawboo/board-core')
  const esm = cjs.replace(/\.js$/, '.mjs')

  const SPEC_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g

  /** Every bare (non-relative) specifier reachable from `file`, following relative
   *  chunk hops so code-splitting can't hide a dependency one file away. */
  function bareSpecifiers(file: string, seen = new Set<string>()): string[] {
    if (seen.has(file)) return []
    seen.add(file)
    const out: string[] = []
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPEC_RE)) {
      if (spec.startsWith('.')) {
        out.push(...bareSpecifiers(path.resolve(path.dirname(file), spec), seen))
      } else {
        out.push(spec)
      }
    }
    return out
  }

  it('is built (run `pnpm --filter @clawboo/board-core build` if this fails)', () => {
    expect(existsSync(cjs)).toBe(true)
    expect(existsSync(esm)).toBe(true)
  })

  // Asserting ZERO bare specifiers beats a node:/better-sqlite3/drizzle-orm denylist:
  // one rule, nothing to keep up to date, and a newly-added dependency can't slip past.
  it('declares no bare import specifier in either format', () => {
    expect(bareSpecifiers(esm)).toEqual([])
    expect(bareSpecifiers(cjs)).toEqual([])
  })

  // Belt to the artifact check's suspenders: the SOURCE stays dependency-free too,
  // so the guarantee doesn't hinge on a fresh build. Lives here rather than in
  // board-core's own suite so that package's tsconfig can pin `"types": []` (its
  // tests then need no node imports, and a node global in its source is a
  // typecheck failure). `from`-clause matching covers plain imports AND re-exports
  // (`export * from`, `export { x } from`, `export * as ns from`) — a re-export
  // adds a dependency without any `import` statement.
  describe('the state-machine SOURCE is import-free', () => {
    const source = readFileSync(
      path.join(path.dirname(cjs), '..', 'src', 'state-machine.ts'),
      'utf8',
    )
    // Same lexer-grade stripping as the sweep above — see stripComments.
    const code = stripComments(source)

    it('has no import, re-export, require, or dynamic import', () => {
      expect(code).not.toMatch(/\bfrom\s*['"]/)
      expect(code).not.toMatch(/^\s*import\s/m)
      expect(code).not.toMatch(/\bimport\s*\(/)
      expect(code).not.toMatch(/\brequire\s*\(/)
    })

    it('references no node builtin', () => {
      expect(code).not.toMatch(/['"]node:/)
    })

    it('the from-clause check would catch a re-export (scanner self-test)', () => {
      // Built via interpolation so this file's own text never contains a
      // `from '<specifier>'` sequence the sweep above would flag.
      for (const bad of [
        `export * from '${SPECIFIER}'`,
        `export { createDb } from '${SPECIFIER}'`,
        `export * as db from '${SPECIFIER}'`,
        `export type { DbTask } from '${SPECIFIER}'`,
      ]) {
        expect(bad).toMatch(/\bfrom\s*['"]/)
      }
    })
  })
})
