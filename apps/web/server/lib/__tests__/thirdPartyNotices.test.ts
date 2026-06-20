// elkjs (the EPL-2.0 graph-layout backend) is a bundled production dependency of
// the dashboard, so it must be attributed in THIRD_PARTY_NOTICES.md. This guards
// the notice against silent removal on a future dep bump.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('THIRD_PARTY_NOTICES.md attributes bundled non-MIT/Apache deps', () => {
  it('lists elkjs and its EPL-2.0 license', () => {
    const notices = readFileSync(path.join(repoRoot(), 'THIRD_PARTY_NOTICES.md'), 'utf8')
    expect(notices).toContain('elkjs')
    expect(notices).toContain('EPL-2.0')
  })
})
