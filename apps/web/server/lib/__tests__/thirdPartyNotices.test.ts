// elkjs (the EPL-2.0 graph-layout backend) is a bundled production dependency of
// the dashboard, so it must be attributed in THIRD_PARTY_NOTICES.md. This guards
// the notice against silent removal on a future dep bump.
//
// The bundled deps are inlined into dist/server.js and dist/ui/ at build time, so
// their own license files never reach the user's node_modules — the aggregated
// notices file is the only place those notices ship. These tests guard both the
// content AND the wiring that puts the file into the published tarball.

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

describe('THIRD_PARTY_NOTICES.md ships in the published CLI package', () => {
  // The inlined deps' notices reach users only via this file. Guard the two links
  // in the ship path so a future assemble/files change cannot silently drop it:
  //   1. assemble-cli.sh copies it into the CLI dist dir, and
  //   2. the CLI package publishes dist/.

  it('is copied into the CLI dist by assemble-cli.sh', () => {
    const assemble = readFileSync(path.join(repoRoot(), 'scripts/assemble-cli.sh'), 'utf8')
    // A cp of THIRD_PARTY_NOTICES.md into the assembled CLI dist ($CLI_DIST).
    expect(assemble).toMatch(
      /cp\s+"\$ROOT\/THIRD_PARTY_NOTICES\.md"\s+"\$CLI_DIST\/THIRD_PARTY_NOTICES\.md"/,
    )
  })

  it('publishes dist/ so the copied notices reach the tarball', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot(), 'apps/cli/package.json'), 'utf8'),
    ) as { files?: string[] }
    expect(pkg.files).toContain('dist')
  })
})
