// Supply-chain guard: assert that every `pnpm install` in CI carries
// `--frozen-lockfile`, so a future workflow edit can't silently reintroduce the
// lockfile-mutation attack surface. Walks up to the repo's `.github/workflows`.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

function findWorkflowsDir(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.github', 'workflows')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

describe('CI supply-chain: --frozen-lockfile guard', () => {
  it('every `pnpm install` line in CI uses --frozen-lockfile', () => {
    const wf = findWorkflowsDir()
    expect(wf).not.toBeNull()
    if (!wf) return
    const files = readdirSync(wf).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const f of files) {
      readFileSync(path.join(wf, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/pnpm\s+install\b/.test(line) && !line.includes('--frozen-lockfile')) {
            offenders.push(`${f}:${i + 1}: ${line.trim()}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })
})
