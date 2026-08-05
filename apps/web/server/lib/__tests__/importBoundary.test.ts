// Layer-boundary guard. `apps/web/server` (Express, tsup-bundled for Node) and
// `apps/web/src` (the Vite browser SPA) are separate build targets; packages are
// the shared layer and must not depend on apps. `eslint.config.mjs` enforces all
// three directions, and this test asserts the enforcement is actually WIRED:
//
//   (1) the rules fire on each violation shape (static, `@/` alias, dynamic import),
//   (2) they stay quiet on legitimate imports, and
//   (3) `apps/web`'s lint script still covers `server/`.
//
// (3) is the one that matters most. The server tree was historically unlinted
// (`"lint": "eslint src/"`), so narrowing that script back would silently kill
// the server-side rule while every other test in the repo still passed.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('repo root (pnpm-workspace.yaml) not found')
}

const ROOT = repoRoot()

// Let ESLint DISCOVER the config rather than passing `overrideConfigFile`: only
// the discovery path sets the config's own directory as the base for `files:`
// globs. With an explicit config path the base becomes the cwd, the repo-root-
// relative `files: ['apps/web/server/**']` never matches, and this whole suite
// would pass while testing nothing. Loading the config is the expensive part
// (it pulls in typescript-eslint), so build one instance and reuse it.
const eslint = new ESLint({ cwd: ROOT })

// The probe paths need not exist on disk — `lintText` only uses them to decide
// which config blocks apply.
const SERVER_FILE = path.join(ROOT, 'apps/web/server/api/__importBoundaryProbe.ts')
const SPA_FILE = path.join(ROOT, 'apps/web/src/lib/__importBoundaryProbe.ts')
const PACKAGE_FILE = path.join(ROOT, 'packages/model-catalog/src/__importBoundaryProbe.ts')

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false })
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(fatal)')
}

describe('server → SPA imports are blocked', () => {
  it('flags a static relative import into src/, at any nesting depth', async () => {
    expect(
      await ruleIdsFor(
        "import { x } from '../../src/lib/modelCatalog'\nexport const a = x\n",
        SERVER_FILE,
      ),
    ).toContain('no-restricted-imports')
    expect(
      await ruleIdsFor(
        "import { x } from '../../../src/features/teams/y'\nexport const a = x\n",
        SERVER_FILE,
      ),
    ).toContain('no-restricted-imports')
  }, 60_000)

  it('flags the @/ path alias', async () => {
    expect(
      await ruleIdsFor("import { x } from '@/lib/modelCatalog'\nexport const a = x\n", SERVER_FILE),
    ).toContain('no-restricted-imports')
  })

  it('flags a type-only import and a re-export', async () => {
    expect(
      await ruleIdsFor(
        "import type { X } from '../../src/lib/y'\nexport type A = X\n",
        SERVER_FILE,
      ),
    ).toContain('no-restricted-imports')
    expect(await ruleIdsFor("export * from '../src/lib/y'\n", SERVER_FILE)).toContain(
      'no-restricted-imports',
    )
  })

  it('flags a dynamic import(), which no-restricted-imports alone does not see', async () => {
    expect(
      await ruleIdsFor(
        "export const a = async () => (await import('../../src/lib/y')).x\n",
        SERVER_FILE,
      ),
    ).toContain('no-restricted-syntax')
    expect(
      await ruleIdsFor("export const a = async () => (await import('@/lib/y')).x\n", SERVER_FILE),
    ).toContain('no-restricted-syntax')
  })

  it('leaves legitimate server imports alone', async () => {
    const code = [
      "import express from 'express'",
      "import fs from 'node:fs'",
      "import { MODEL_GROUPS } from '@clawboo/model-catalog'",
      "import { runCascadeContract } from '@clawboo/team-orchestration/contract'",
      "import { a } from '../../lib/teamChat/x'",
      "import { b } from './sibling'",
      "export const lazy = async () => (await import('node:child_process')).spawn",
      'export const use = [express, fs, MODEL_GROUPS, runCascadeContract, a, b]',
    ].join('\n')
    const ids = await ruleIdsFor(code, SERVER_FILE)
    expect(ids.filter((id) => id.startsWith('no-restricted-'))).toEqual([])
  })
})

describe('SPA → server imports are blocked', () => {
  it('flags a static relative import into server/', async () => {
    expect(
      await ruleIdsFor(
        "import { x } from '../../../../server/api/onboardingSeed'\nexport const a = x\n",
        SPA_FILE,
      ),
    ).toContain('no-restricted-imports')
  })

  it('flags a dynamic import() into server/', async () => {
    expect(
      await ruleIdsFor(
        "export const a = async () => (await import('../../server/api/system')).x\n",
        SPA_FILE,
      ),
    ).toContain('no-restricted-syntax')
  })

  it('does not flag bare specifiers that merely end in /server', async () => {
    // The reason the patterns are relative-only: `react-dom/server` is a real
    // package entry point, not a layer violation.
    const code =
      "import { renderToString } from 'react-dom/server'\nexport const a = renderToString\n"
    const ids = await ruleIdsFor(code, SPA_FILE)
    expect(ids.filter((id) => id.startsWith('no-restricted-'))).toEqual([])
  })
})

describe('packages → apps imports are blocked', () => {
  it('flags a relative import into apps/', async () => {
    expect(
      await ruleIdsFor(
        "import { x } from '../../../apps/web/src/lib/y'\nexport const a = x\n",
        PACKAGE_FILE,
      ),
    ).toContain('no-restricted-imports')
  })
})

describe('the rules are actually reachable from CI', () => {
  it("apps/web's lint script covers server/, not just src/", () => {
    // Without this, every rule above is dead in `pnpm lint` — the tests would
    // still pass because they invoke ESLint directly.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'apps/web/package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.['lint']).toMatch(/(^|\s)server\/?(\s|$)/)
  })

  it('the global dist/ ignore is its own config object', () => {
    // Flat config only treats `ignores` as a GLOBAL ignore when it is the sole
    // key of its object. Merged with `rules`, it silently degrades to a
    // per-object exclusion and build output gets linted by every other block.
    const config = readFileSync(path.join(ROOT, 'eslint.config.mjs'), 'utf8')
    expect(config).toMatch(/\{\s*ignores: \[[^\]]*'\*\*\/dist\/\*\*'[^\]]*\],\s*\}/)
  })
})
