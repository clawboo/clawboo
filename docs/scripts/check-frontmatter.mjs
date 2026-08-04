#!/usr/bin/env node
// Validates every Mintlify page in this directory against the two content
// mistakes that break the deployed docs site.
//
// 1. Frontmatter. Mintlify parses it as YAML, so an unquoted `title` /
//    `description` value containing `: ` parses as a nested mapping (or fails
//    outright), and the page ships as a 404 instead of rendering. `mint
//    broken-links` does not catch it (it only checks links); only a full build
//    does.
// 2. A bare `%` in a body heading. Mintlify URI-decodes headings to build anchor
//    slugs, and a `%` that isn't valid percent-encoding raises `URIError: URI
//    malformed`, failing the whole page. This one is the mirror image of the
//    first: `mint broken-links` surfaces it while a `mint dev` build can render
//    straight past it. A `%` in ordinary prose is fine — only headings trip it.
//
// Both have been live before, and CI runs no Mintlify build at all, so this is
// the automated gate that keeps the conventions in ./README.md from regressing.
//
// Run it with `pnpm check:docs` from the repo root, or
// `pnpm --filter @clawboo/docs check-frontmatter`. It also runs as this
// package's `lint` script, so `pnpm lint` and CI's Lint job cover it.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// Resolved from this file rather than cwd, so the script works from anywhere.
const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

// Asset directories hold no pages.
const SKIP_DIRS = new Set(['node_modules', 'fonts', 'images', 'logo', 'screenshots'])

// The contributor readme for this directory, not a Mintlify page: it is absent
// from docs.json's navigation and deliberately carries no frontmatter.
const SKIP_PAGES = new Set(['README.md'])

// Every page today sets exactly these two keys, and Mintlify uses both (the
// title becomes the page heading and nav label, the description the meta tag).
const REQUIRED_KEYS = ['title', 'description']

const QUOTE_HINT =
  'wrap the value in quotes if it contains a colon, or starts with `@` or a backtick'

// A page opens with `---`, then the YAML block, then a closing `---` on its own
// line. Lazy so a `---` thematic break in the body can never be mistaken for it.
const FRONTMATTER = /^---\n([\s\S]*?)^---[ \t]*(?:\n|$)/m

const HEADING = /^#{1,6}\s/
const FENCE = /^\s*(```|~~~)/
// A `%` is only safe in a heading when it reads as percent-encoding (`%20`).
const BARE_PERCENT = /%(?![0-9A-Fa-f]{2})/

function collectPages(dir, found = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectPages(path, found)
    } else if (/\.mdx?$/.test(entry.name) && !SKIP_PAGES.has(relative(DOCS_DIR, path))) {
      found.push(path)
    }
  }
  return found
}

// Body headings only. Fenced blocks are skipped, so a shell comment such as
// `# restore 50% of the budget` inside a ```bash fence is not mistaken for one.
function checkHeadings(label, body, firstBodyLine) {
  const problems = []
  let inFence = false
  body.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence || !HEADING.test(line) || !BARE_PERCENT.test(line)) return
    problems.push(
      `${label}:${firstBodyLine + index}: bare \`%\` in a heading breaks ` +
        '`mint broken-links` with `URIError: URI malformed`',
    )
    problems.push('    reword the heading; a `%` in ordinary prose is fine')
  })
  return problems
}

function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'object') return 'a nested mapping (an unquoted `: ` in the value?)'
  return `a ${typeof value}`
}

function checkPage(path) {
  const label = relative(DOCS_DIR, path)
  // Normalize CRLF so a Windows checkout doesn't fail every page.
  const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

  if (!source.startsWith('---\n')) {
    return [`${label}: no YAML frontmatter — the file must open with a \`---\` line`]
  }

  const block = source.match(FRONTMATTER)
  if (!block) {
    return [`${label}: the frontmatter block is never closed — expected a second \`---\` line`]
  }

  let data
  try {
    data = parse(block[1])
  } catch (error) {
    const detail = String(error.message).split('\n')[0]
    return [`${label}: frontmatter is not valid YAML — ${detail}`, `    ${QUOTE_HINT}`]
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return [`${label}: frontmatter must be a mapping of keys to values`]
  }

  const problems = []
  for (const key of REQUIRED_KEYS) {
    const value = data[key]
    if (value === undefined) {
      problems.push(`${label}: frontmatter is missing \`${key}\``)
    } else if (typeof value !== 'string') {
      // The silent variant: an unquoted `: ` that YAML accepts as nesting
      // rather than rejecting outright.
      problems.push(`${label}: \`${key}\` is ${describeValue(value)}, not a string`)
      problems.push(`    ${QUOTE_HINT}`)
    } else if (value.trim() === '') {
      problems.push(`${label}: \`${key}\` is empty`)
    }
  }

  const frontmatterLines = block[0].split('\n').length - 1
  problems.push(...checkHeadings(label, source.slice(block[0].length), frontmatterLines + 1))
  return problems
}

const pages = collectPages(DOCS_DIR)
const failures = pages.map(checkPage).filter((problems) => problems.length > 0)

if (failures.length > 0) {
  console.error(`[docs] ✖ Problems in ${failures.length} of ${pages.length} pages:\n`)
  for (const problem of failures.flat()) console.error(`  ${problem}`)
  console.error(
    '\n[docs] Mintlify serves a page it cannot parse as a 404.' +
      '\n[docs] See docs/README.md, and preview with `mint dev` before opening the PR.',
  )
  process.exitCode = 1
} else {
  console.log(`[docs] ✓ Frontmatter and headings valid on all ${pages.length} pages.`)
}
