// Repo hygiene guard — comprehensive working-tree surface. Shells `git grep
// --untracked` over tracked AND untracked-not-ignored files and asserts no
// internal build-session shorthand (an S-code or a session-number marker) and no
// external build-aid path fragment leaks into what the repository actually ships.
//
// This is the suspenders to repoHygiene.test.ts's belt: that guard walks
// apps/+packages/+scripts on disk (the no-git belt, and the home of the
// comment-scoped Phase check); this one scans every file of EVERY extension across
// the whole tree via git, which — with `--untracked` — is comprehensive EVEN while
// the build is uncommitted (git still respects .gitignore + .git/info/exclude, so
// dist/, node_modules/, and the local-only working docs are skipped). The S-code
// is matched case-insensitively on its `S` prefix (`[sS][0-9]{2}`, S00–S99) to
// catch a lowercase `s13`; the SESSION/Session markers stay case-sensitive so a
// lowercase `session-1` sessionKey fixture is never flagged. `-I` skips binary
// blobs. Skips cleanly outside a git work tree. No new dependency — `git` + node's
// child_process only.
//
// The path-fragment patterns below appear literally in this file, which is exactly
// why the pathspec excludes this file and its sibling guard from the scan.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('repo root (pnpm-workspace.yaml) not found')
}

function insideGitWorkTree(root: string): boolean {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    )
  } catch {
    return false
  }
}

// Written so this file matches none of the S-code / session-marker forms itself
// (e.g. the bracket after `S` is never a digit). The four path fragments DO appear
// literally — handled by the self-exclusion pathspec.
const PATTERNS = [
  String.raw`\b[sS][0-9]{2}\b`,
  String.raw`SESSION-[0-9]`,
  String.raw`\bSession[- ][0-9]`,
  'clawboo-build-docs',
  'trustclaw',
  'users-sanju-claude-plans',
  'clawboo-orchestrator-SESSION',
]

// Only the single marketplace file that carries a real engineering-standard token
// (a Canadian steel-design code) is excluded — not the whole agents tree, so a
// real leak planted in any other persona file is still caught. The two
// hygiene-guard files hold the patterns literally.
const EXCLUDES = [
  ':!apps/web/src/features/marketplace/agents/agency/specialized.ts',
  ':!apps/web/server/lib/__tests__/repoHygiene.test.ts',
  ':!apps/web/server/lib/__tests__/repoHygieneTracked.test.ts',
]

describe('repo hygiene (tracked surface): a git grep over committed files leaks nothing', () => {
  it('git grep finds no build-session shorthand or build-aid path fragment in any tracked file', () => {
    const root = repoRoot()
    // Outside a git checkout (e.g. an extracted tarball in a sandbox) the
    // filesystem-walk guard still covers .ts/.tsx; nothing to scan here.
    if (!insideGitWorkTree(root)) return

    const args = ['grep', '--untracked', '--no-color', '-I', '-nE']
    for (const p of PATTERNS) args.push('-e', p)
    args.push('--', '.', ...EXCLUDES)

    let stdout = ''
    try {
      // exit 0 from git grep means matches were found (a leak) → stdout holds them.
      stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      // exit 1 means NO matches — the clean path; anything else is a real error.
      if (e.status === 1) stdout = e.stdout ?? ''
      else throw err
    }

    const offenders = stdout.split('\n').filter((line) => line.trim().length > 0)
    expect(offenders).toEqual([])
  })
})
