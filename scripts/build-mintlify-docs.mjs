#!/usr/bin/env node
// Generate the Mintlify docs site (apps/docs/) from the canonical portable Markdown (docs/).
// The docs/ tree stays the source of truth; this is a pure, repeatable build step (no lock-in).
// Per page: strip internal provenance/HTML comments, convert GFM alerts -> Mintlify callout
// components, rewrite relative .md links to Mintlify root paths, rewrite screenshot image paths,
// emit as .mdx. Also copies assets and generates docs.json (nav + theme).
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const SRC = path.join(REPO, 'docs')
const OUT = path.join(REPO, 'apps', 'docs')
const EXCLUDE_DIRS = new Set(['_meta', 'screenshots'])
const EXCLUDE_FILES = new Set(['clawboo-design-system.md', 'llms.txt'])
const ALERT = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Info', WARNING: 'Warning', CAUTION: 'Danger' }

const GH = 'https://github.com/clawboo/clawboo/blob/main'
const stats = { pages: 0, alerts: 0, links: 0, images: 0, gh: 0, comments: 0 }

function listMd(dir, rel = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue
      out.push(...listMd(path.join(dir, e.name), path.posix.join(rel, e.name)))
    } else if (e.name.endsWith('.md') && !EXCLUDE_FILES.has(e.name)) {
      out.push(path.posix.join(rel, e.name))
    }
  }
  return out
}

function splitFrontmatter(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/)
  return m ? { fm: m[0], body: text.slice(m[0].length) } : { fm: '', body: text }
}

function stripComments(s) {
  return s.replace(/\n?<!--[\s\S]*?-->\s*$/g, '').replace(/<!--[\s\S]*?-->/g, () => {
    stats.comments++
    return ''
  })
}

// Convert GFM blockquote alerts to Mintlify callout components.
function convertAlerts(body) {
  const lines = body.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/)
    if (!m) {
      out.push(lines[i])
      continue
    }
    const comp = ALERT[m[1]]
    const content = []
    if (m[2].trim()) content.push(m[2].trim())
    let j = i + 1
    for (; j < lines.length; j++) {
      if (/^>/.test(lines[j])) content.push(lines[j].replace(/^>\s?/, ''))
      else break
    }
    while (content.length && content[content.length - 1].trim() === '') content.pop()
    out.push(`<${comp}>`)
    out.push(...content)
    out.push(`</${comp}>`)
    stats.alerts++
    i = j - 1
  }
  return out.join('\n')
}

// Rewrite markdown links:
//   screenshots/*           -> /images/*
//   *.md inside docs/       -> /root-path (extensionless page path)
//   anything else relative  -> GitHub blob URL (repo source: LICENSE, *.ts, files outside docs/)
function rewriteLinks(body, relFile) {
  const dir = path.posix.dirname(relFile)
  return body.replace(/\]\(([^)]+)\)/g, (whole, target) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole
    if (/\s/.test(target)) return whole // leave links-with-titles untouched
    const hashI = target.indexOf('#')
    const pathPart = hashI === -1 ? target : target.slice(0, hashI)
    const anchor = hashI === -1 ? '' : target.slice(hashI)
    if (!pathPart) return whole
    const imgm = pathPart.match(/^(?:\.\.?\/)*screenshots\/(.+)$/)
    if (imgm) {
      stats.images++
      return `](/images/${imgm[1]}${anchor})`
    }
    const docsRel = path.posix.normalize(path.posix.join(dir, pathPart))
    if (pathPart.endsWith('.md') && !docsRel.startsWith('..')) {
      stats.links++
      return `](/${docsRel.replace(/\.md$/, '')}${anchor})`
    }
    const repoRel = path.posix.normalize(path.posix.join('docs', dir, pathPart))
    if (!repoRel.startsWith('..')) {
      stats.gh++
      return `](${GH}/${repoRel}${anchor})`
    }
    return whole
  })
}

function convert(relFile) {
  const raw = fs.readFileSync(path.join(SRC, relFile), 'utf8')
  const { fm, body } = splitFrontmatter(raw)
  // Mintlify renders the frontmatter `title` as the page H1, so strip the body's leading H1
  // (the portable Markdown keeps it for GitHub rendering; here it would double the heading).
  let b = stripComments(body).replace(/^\s*#\s+[^\n]*\n+/, '')
  b = convertAlerts(b)
  b = rewriteLinks(b, relFile)
  const outRel = relFile.replace(/\.md$/, '.mdx')
  const dest = path.join(OUT, outRel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, fm + b.replace(/\s*$/, '') + '\n')
  stats.pages++
  return outRel.replace(/\.mdx$/, '')
}

// ---- build ----
for (const e of fs.readdirSync(OUT, { withFileTypes: true })) {
  if (['package.json', 'README.md', '.turbo'].includes(e.name)) continue
  fs.rmSync(path.join(OUT, e.name), { recursive: true, force: true })
}

const files = listMd(SRC)
const pagePaths = new Set(files.map((f) => convert(f)))

// assets
fs.mkdirSync(path.join(OUT, 'images'), { recursive: true })
for (const f of fs.readdirSync(path.join(SRC, 'screenshots'))) {
  if (/\.(png|webp|jpg|jpeg|gif|svg)$/i.test(f)) {
    fs.copyFileSync(path.join(SRC, 'screenshots', f), path.join(OUT, 'images', f))
  }
}
fs.mkdirSync(path.join(OUT, 'logo'), { recursive: true })
fs.copyFileSync(path.join(REPO, 'apps/web/public/logo.svg'), path.join(OUT, 'logo', 'light.svg'))
fs.copyFileSync(path.join(REPO, 'apps/web/public/logo.svg'), path.join(OUT, 'logo', 'dark.svg'))
fs.copyFileSync(path.join(REPO, 'apps/web/public/favicon.svg'), path.join(OUT, 'favicon.svg'))

// ---- docs.json navigation (ordered; index first per group) ----
const rest = (prefix, first = []) => {
  const depth = prefix.split('/').length + 1
  const all = [...pagePaths].filter(
    (p) => p.startsWith(prefix + '/') && p.split('/').length === depth,
  )
  const ordered = [...first.filter((f) => pagePaths.has(f))]
  for (const p of all.sort()) if (!ordered.includes(p)) ordered.push(p)
  return ordered
}

const docsJson = {
  $schema: 'https://mintlify.com/docs.json',
  theme: 'mint',
  name: 'Clawboo',
  colors: { primary: '#dc2a48', light: '#E94560', dark: '#E94560' },
  favicon: '/favicon.svg',
  logo: { light: '/logo/light.svg', dark: '/logo/dark.svg' },
  navigation: {
    tabs: [
      {
        tab: 'Documentation',
        groups: [
          {
            group: 'Introduction',
            pages: rest('intro', [
              'intro/index',
              'intro/what-is-clawboo',
              'intro/how-it-works',
              'intro/why-clawboo',
            ]),
          },
          {
            group: 'Getting Started',
            pages: rest('getting-started', [
              'getting-started/index',
              'getting-started/installation',
              'getting-started/quickstart-native',
              'getting-started/quickstart-openclaw',
              'getting-started/first-team',
              'getting-started/dashboard-tour',
            ]),
          },
          {
            group: 'Core Concepts',
            pages: rest('concepts', [
              'concepts/index',
              'concepts/agent-model',
              'concepts/teams-and-planes',
              'concepts/the-board',
              'concepts/delegation-and-orchestration',
              'concepts/peer-chat',
              'concepts/memory',
              'concepts/capabilities',
              'concepts/verification',
              'concepts/governance',
              'concepts/observability',
              'concepts/worktrees-and-handoff',
              'concepts/scheduling',
              'concepts/gateway-and-events',
              'concepts/architecture-invariants',
            ]),
          },
          {
            group: 'Runtimes',
            pages: rest('runtimes', [
              'runtimes/index',
              'runtimes/native',
              'runtimes/openclaw',
              'runtimes/claude-code',
              'runtimes/codex',
              'runtimes/hermes',
              'runtimes/connecting-runtimes',
            ]),
          },
          { group: 'Using Clawboo', pages: rest('using', ['using/index']) },
          {
            group: 'Operating',
            pages: rest('operating', [
              'operating/index',
              'operating/deployment',
              'operating/security',
              'operating/mcp-servers',
              'operating/data-and-state',
              'operating/production-defaults',
            ]),
          },
          { group: 'Guides & Cookbook', pages: rest('guides', ['guides/index']) },
        ],
      },
      {
        tab: 'Reference',
        groups: [
          {
            group: 'Reference',
            pages: rest('reference', [
              'reference/index',
              'reference/cli',
              'reference/configuration',
              'reference/environment-variables',
              'reference/database-schema',
              'reference/mcp-tools',
              'reference/marketplace-catalog',
              'reference/events-and-errors',
            ]),
          },
          { group: 'REST API', pages: rest('reference/rest-api', ['reference/rest-api/index']) },
          { group: 'Packages', pages: rest('reference/packages', ['reference/packages/index']) },
        ],
      },
      {
        tab: 'Internals',
        groups: [
          {
            group: 'Internals & Contributing',
            pages: rest('internals', [
              'internals/index',
              'internals/monorepo-and-build',
              'internals/runtime-adapter',
              'internals/agent-source',
              'internals/seams',
              'internals/executor-runner',
              'internals/board-internals',
              'internals/event-pipeline',
              'internals/testing',
              'internals/release-process',
              'internals/codegen-and-ingestion',
              'internals/design-system',
            ]),
          },
        ],
      },
      {
        tab: 'Resources',
        groups: [
          {
            group: 'Appendices',
            pages: rest('appendices', [
              'appendices/glossary',
              'appendices/known-issues',
              'appendices/faq',
              'appendices/changelog',
              'appendices/contributing',
              'appendices/license-and-notices',
            ]),
          },
        ],
      },
    ],
  },
  navbar: {
    primary: { type: 'button', label: 'GitHub', href: 'https://github.com/clawboo/clawboo' },
  },
  footer: { socials: { github: 'https://github.com/clawboo/clawboo' } },
}

const inNav = new Set()
for (const t of docsJson.navigation.tabs)
  for (const g of t.groups) for (const p of g.pages) inNav.add(p)
const orphans = [...pagePaths].filter((p) => !inNav.has(p))
fs.writeFileSync(path.join(OUT, 'docs.json'), JSON.stringify(docsJson, null, 2) + '\n')

console.log(
  `pages=${stats.pages} alerts=${stats.alerts} links=${stats.links} gh-links=${stats.gh} images=${stats.images}`,
)
console.log(`nav-pages=${inNav.size} generated=${pagePaths.size} orphans=${orphans.length}`)
if (orphans.length) console.log('ORPHANS:', orphans.join(', '))
