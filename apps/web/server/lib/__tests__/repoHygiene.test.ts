// Repo hygiene guard (working-tree filesystem walk). The product source must
// stand on its own: no internal build-session shorthand (an S-code, or a
// session-number marker), no build-phase marker ("Phase NN"), and no external
// build-aid path fragment may leak into shipped code, comments, schema, scripts,
// or test titles. Walks apps/ + packages/ + scripts/ across every shipped
// extension and asserts ZERO matches — this is the guard that covers brand-new,
// not-yet-committed files (its sibling repoHygieneTracked walks git instead).
//
// Pattern discipline (case sensitivity is deliberate):
//   - The S-code is matched case-INSENSITIVELY on its `S` prefix (`[sS][0-9]{2}`)
//     because the real leak was a lowercase `s13`. It is widened to S00–S99 so a
//     session number above 39 can't slip past.
//   - The SESSION / Session markers stay case-SENSITIVE so legitimate domain code
//     (a lowercase `session-1` sessionKey fixture) is never flagged.
//   - "Phase NN" is restricted to COMMENT lines of CODE files, so a marketplace
//     persona that mentions project phases, a markdown bullet, or a string
//     fixture is never flagged.
// The single marketplace file carrying a real engineering-standard token (a
// Canadian steel-design code) is excluded; both hygiene-guard files are excluded
// because they hold the path-fragment patterns literally.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

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

export const WALK_ROOTS = ['apps', 'packages', 'scripts']
export const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage'])
export const SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.cjs',
  '.css',
  '.json',
  '.sql',
  '.yml',
  '.yaml',
  '.md',
])
// Extensions whose comment lines are scanned for the "Phase NN" marker — code
// plus CSS (both use //- or /* */-style comments; the marker never appears in a
// markdown bullet or a JSON/SQL string we care to guard).
const CODE_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.css'])

// Build-session shorthand + external build-aid path fragments. Tested on EVERY
// line of EVERY scanned file. (Self-match-safe: the `S` here is followed by `[`,
// never a digit — see the bracket; the four path fragments appear literally,
// which is why both guard files self-exclude.)
export const ANY_LINE_PATTERNS: readonly RegExp[] = [
  /\b[sS][0-9]{2}\b/, // build-session code, S00–S99 / s00–s99
  /\bSESSION-[0-9]/, // case-sensitive: lowercase session-1 is a domain sessionKey
  /\bSession[- ][0-9]/, // case-sensitive, same reason
  /clawboo-build-docs/i,
  /trustclaw/i,
  /users-sanju-claude-plans/i,
  /clawboo-orchestrator-SESSION/i,
]

// Build-phase marker — comment lines of code files only.
export const COMMENT_PHASE_PATTERN = /\bphases? [0-9]/i

function isCommentLine(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('{/*')
}

function* sourceFiles(
  root: string,
  dir: string,
  exts: Set<string>,
  excludeRel: string[],
): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full)
    if (excludeRel.some((ex) => rel === ex || rel.startsWith(ex + path.sep))) continue
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      yield* sourceFiles(root, full, exts, excludeRel)
    } else if (exts.has(path.extname(entry.name))) {
      yield full
    }
  }
}

/**
 * Pure scan: walk `walkRoots` under `root`, return `"<relpath>:<line>: <text>"`
 * for every line that trips a build-session / path-fragment pattern, plus every
 * code-comment line that trips the build-phase pattern. Exported so the real
 * guard and the planted-leak proof exercise the SAME logic.
 */
export function collectHygieneOffenders(
  root: string,
  walkRoots: string[],
  exts: Set<string>,
  excludeRel: string[],
): string[] {
  const offenders: string[] = []
  for (const base of walkRoots) {
    const start = path.join(root, base)
    if (!existsSync(start)) continue
    for (const file of sourceFiles(root, start, exts, excludeRel)) {
      const isCode = CODE_EXT.has(path.extname(file))
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const hit =
            ANY_LINE_PATTERNS.some((re) => re.test(line)) ||
            (isCode && isCommentLine(line) && COMMENT_PHASE_PATTERN.test(line))
          if (hit) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`)
        })
    }
  }
  return offenders
}

const MARKETPLACE_STEEL_CODE_FILE = path.join(
  'apps',
  'web',
  'src',
  'features',
  'marketplace',
  'agents',
  'agency',
  'specialized.ts',
)
const GUARD_FILES = [
  path.join('apps', 'web', 'server', 'lib', '__tests__', 'repoHygiene.test.ts'),
  path.join('apps', 'web', 'server', 'lib', '__tests__', 'repoHygieneTracked.test.ts'),
]

describe('repo hygiene: no build-session/phase markers leak into product source', () => {
  it('apps/ + packages/ + scripts/ are free of S-codes, session/phase markers, and build-aid paths', () => {
    const offenders = collectHygieneOffenders(repoRoot(), WALK_ROOTS, SOURCE_EXT, [
      MARKETPLACE_STEEL_CODE_FILE,
      ...GUARD_FILES,
    ])
    expect(offenders).toEqual([])
  })
})

describe('repo hygiene guard: the broadened scan actually catches planted leaks', () => {
  let tmp: string | null = null
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
    tmp = null
  })

  it('flags a lowercase s-code in a .mjs, a // Phase comment, and a build-aid path; passes when clean', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'clawboo-hygiene-'))
    mkdirSync(path.join(tmp, 'scripts'), { recursive: true })
    const leakFile = path.join(tmp, 'scripts', 'planted.mjs')

    // Three distinct leak classes the narrow guard missed: a lowercase S-code in
    // a non-.ts file, a build-phase comment, and an external build-aid path.
    writeFileSync(
      leakFile,
      [
        'const label = "s13"',
        '// Phase 7 — build marker',
        'const where = "trustclaw/scratch"',
        '',
      ].join('\n'),
    )
    const offenders = collectHygieneOffenders(tmp, ['scripts'], SOURCE_EXT, [])
    expect(offenders.some((o) => o.includes('s13'))).toBe(true)
    expect(offenders.some((o) => /Phase 7/.test(o))).toBe(true)
    expect(offenders.some((o) => o.includes('trustclaw'))).toBe(true)

    // The Phase pattern is comment-scoped: the same text in a STRING literal is
    // NOT a leak (proves persona prose / fixtures don't false-positive).
    writeFileSync(leakFile, ['const note = "phase 1 of the rollout"', ''].join('\n'))
    expect(collectHygieneOffenders(tmp, ['scripts'], SOURCE_EXT, [])).toEqual([])
  })
})
