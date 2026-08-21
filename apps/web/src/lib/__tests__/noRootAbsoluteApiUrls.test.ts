// Every network call the SPA makes must go through the base-aware seam in
// @clawboo/control-client, because clawboo can be mounted under a URL path
// prefix (CLAWBOO_BASE_PATH) and a root-absolute `/api/...` escapes the mount.
//
// This is a SOURCE SCAN rather than a lint rule on purpose. The ESLint selectors
// in eslint.config.mjs can only see a URL literal sitting directly in a
// `fetch(...)` / `new EventSource(...)` argument list, and real sites reach the
// network through one level of indirection instead: a local `getJson(url)`
// helper, a module-level `ENDPOINT` const, and an injectable EventSource
// `factory`. Each was invisible to the rules while being exactly the bug they
// exist to prevent, and invisible to the e2e too, since the server deliberately
// keeps serving the unprefixed `/api` for its loopback control plane and so
// answers a root-absolute call with a 200.
//
// So the invariant is enforced one step earlier, at the CALL, where the argument
// shape cannot hide it.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// The marketplace catalog is agent PROMPT TEXT, not code: it discusses APIs and
// `fetch` in prose, and none of it is executed.
const DATA_DIRS = [
  path.join('features', 'marketplace', 'agents'),
  path.join('features', 'marketplace', 'teams'),
]

/**
 * Calls that legitimately bypass the seam because their URL is an absolute
 * third-party origin, where a base path is meaningless.
 */
const EXTERNAL_CALLERS = new Set([path.join('features', 'promo', 'GitHubStarButton.tsx')])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__vitest__' || entry === 'node_modules') continue
      sourceFiles(full, out)
      continue
    }
    if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * A call to the global `fetch`, however it is spelled: bare, or through
 * `window.` / `globalThis.` / `self.`. Only `apiFetch` is excluded, and only as a
 * whole word, so `window.fetch(` cannot hide behind the property-access escape.
 * No space before the paren: prose in a comment writes "the board-task fetch (an
 * exec store...)", and a formatted call never does.
 */
const BARE_FETCH = /(^|[^\w.'"`])(?:(?:window|globalThis|self)\.)?fetch\(/
/**
 * A root-absolute `/api/` URL opening a stream. The literal may sit on the next
 * line when prettier wraps the call, so the scan is per-file rather than
 * per-line and tolerates whitespace between the paren and the quote.
 */
const ROOT_ABSOLUTE_SSE = /(?:EventSource|factory)\s*\(\s*['"`]\/api\//

describe('the SPA reaches the API only through the base-aware seam', () => {
  const files = sourceFiles(SRC).filter(
    (f) => !DATA_DIRS.some((d) => path.relative(SRC, f).startsWith(d)),
  )

  it('never calls the global fetch directly', () => {
    // A bare `fetch` skips `apiUrl`, so its URL is whatever the caller wrote,
    // which is how the ObsPanel helper and the update-check const escaped both
    // the lint rules and review.
    const offenders: string[] = []
    for (const file of files) {
      const rel = path.relative(SRC, file)
      if (EXTERNAL_CALLERS.has(rel)) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
          if (BARE_FETCH.test(line)) offenders.push(`${rel}:${i + 1}`)
        })
    }
    expect(
      offenders,
      "Use apiFetch() from '@clawboo/control-client' so the call honors CLAWBOO_BASE_PATH:\n  " +
        offenders.join('\n  '),
    ).toEqual([])
  })

  it('never opens an SSE stream at a root-absolute /api URL', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = path.relative(SRC, file)
      // Whole-file, so a prettier-wrapped call whose URL landed on the next line
      // is still seen.
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(new RegExp(ROOT_ABSOLUTE_SSE, 'g'))) {
        offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(
      offenders,
      'Wrap the stream URL in apiUrl() so it honors CLAWBOO_BASE_PATH:\n  ' +
        offenders.join('\n  '),
    ).toEqual([])
  })
})
