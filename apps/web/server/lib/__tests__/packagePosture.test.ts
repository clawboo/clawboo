// Publish-posture guard. clawboo ships as a single `npx clawboo` CLI that inlines
// its workspace packages into one bundle (tsup `noExternal`); NOTHING else is
// released to npm. So the SOLE publishable artifact is the `clawboo` CLI (apps/cli),
// and every other workspace package is `private: true`. Without this, a public
// package that depends on a private one would publish a manifest pointing at
// packages that are never published — `npm install` would 404. Two invariants:
//   (1) ONLY apps/cli (`clawboo`) is non-private — every other package is private.
//   (2) No non-private package has a runtime `@clawboo/*` dependency on a private one.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

interface Pkg {
  name: string
  private?: boolean
  dependencies: Record<string, string>
  relDir: string
}

function readPkg(root: string, dir: string): Pkg | null {
  const p = path.join(dir, 'package.json')
  if (!existsSync(p)) return null
  const json = JSON.parse(readFileSync(p, 'utf8')) as {
    name?: string
    private?: boolean
    dependencies?: Record<string, string>
  }
  if (!json.name) return null
  return {
    name: json.name,
    private: json.private,
    dependencies: json.dependencies ?? {},
    relDir: path.relative(root, dir).split(path.sep).join('/'),
  }
}

// The pnpm workspace globs: packages/*, packages/adapters/*, apps/*.
function allWorkspacePackages(root: string): Pkg[] {
  const roots = [
    path.join(root, 'packages'),
    path.join(root, 'packages', 'adapters'),
    path.join(root, 'apps'),
  ]
  const out: Pkg[] = []
  for (const base of roots) {
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const pkg = readPkg(root, path.join(base, entry.name))
      if (pkg) out.push(pkg)
    }
  }
  return out
}

describe('publish posture: only the clawboo CLI is publishable; everything else is private', () => {
  const pkgs = allWorkspacePackages(repoRoot())

  it('discovers the workspace packages (sanity)', () => {
    const names = pkgs.map((p) => p.name)
    expect(pkgs.length).toBeGreaterThan(15)
    expect(names).toContain('clawboo') // apps/cli — the published artifact
    expect(names).toContain('@clawboo/db')
  })

  it('ONLY apps/cli (clawboo) is non-private — every other workspace package is private:true', () => {
    const nonPrivate = pkgs.filter((p) => p.private !== true)
    // Diagnostics name the offender(s) on failure.
    expect(nonPrivate.map((p) => `${p.name} (${p.relDir})`)).toEqual(['clawboo (apps/cli)'])
  })

  it('no non-private package has a runtime dependency on a private package', () => {
    const privateNames = new Set(pkgs.filter((p) => p.private === true).map((p) => p.name))
    const violations: string[] = []
    for (const p of pkgs.filter((x) => x.private !== true)) {
      for (const dep of Object.keys(p.dependencies)) {
        if (privateNames.has(dep)) violations.push(`${p.name} -> ${dep} (private)`)
      }
    }
    expect(violations).toEqual([])
  })
})
