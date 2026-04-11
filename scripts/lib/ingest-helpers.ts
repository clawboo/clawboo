/**
 * Shared helper functions for marketplace content ingestion.
 * Used by scripts/ingest-marketplace-content.ts and scripts/verify-ingest.ts.
 *
 * Source repo: https://github.com/msitarzewski/agency-agents
 * Pinned commit: 64eee9f8e04f69b04e78e150d771a443c64720be
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Constants ───────────────────────────────────────────────────────────────

export const AGENCY_AGENTS_SHA = '64eee9f8e04f69b04e78e150d771a443c64720be'
export const AGENCY_AGENTS_REPO = 'msitarzewski/agency-agents'

/** 13 target domains from agency-agents (excludes examples/, finance/, integrations/, scripts/, strategy/) */
export const TARGET_DOMAINS = [
  'academic',
  'design',
  'engineering',
  'game-development',
  'marketing',
  'paid-media',
  'product',
  'project-management',
  'sales',
  'spatial-computing',
  'specialized',
  'support',
  'testing',
] as const

export type AgencyDomain = (typeof TARGET_DOMAINS)[number]

/** Domain → display metadata mapping */
export const DOMAIN_META: Record<AgencyDomain, { emoji: string; color: string; category: string }> =
  {
    academic: { emoji: '🎓', color: '#8B5CF6', category: 'academic' },
    design: { emoji: '🎨', color: '#EC4899', category: 'design' },
    engineering: { emoji: '⚙️', color: '#3B82F6', category: 'engineering' },
    'game-development': { emoji: '🎮', color: '#10B981', category: 'game-dev' },
    marketing: { emoji: '📢', color: '#F59E0B', category: 'marketing' },
    'paid-media': { emoji: '💰', color: '#EF4444', category: 'paid-media' },
    product: { emoji: '🚀', color: '#6366F1', category: 'product' },
    'project-management': { emoji: '📋', color: '#14B8A6', category: 'ops' },
    sales: { emoji: '💼', color: '#F97316', category: 'sales' },
    'spatial-computing': { emoji: '🥽', color: '#7C3AED', category: 'spatial' },
    specialized: { emoji: '🔬', color: '#06B6D4', category: 'specialized' },
    support: { emoji: '🛟', color: '#84CC16', category: 'support' },
    testing: { emoji: '🧪', color: '#A855F7', category: 'testing' },
  }

/** Domain array export name (PascalCase) for generated files */
export const DOMAIN_EXPORT_NAME: Record<AgencyDomain, string> = {
  academic: 'ACADEMIC_AGENTS',
  design: 'DESIGN_AGENTS',
  engineering: 'ENGINEERING_AGENTS',
  'game-development': 'GAME_DEVELOPMENT_AGENTS',
  marketing: 'MARKETING_AGENTS',
  'paid-media': 'PAID_MEDIA_AGENTS',
  product: 'PRODUCT_AGENTS',
  'project-management': 'PROJECT_MANAGEMENT_AGENTS',
  sales: 'SALES_AGENTS',
  'spatial-computing': 'SPATIAL_COMPUTING_AGENTS',
  specialized: 'SPECIALIZED_AGENTS',
  support: 'SUPPORT_AGENTS',
  testing: 'TESTING_AGENTS',
}

// ─── SKILL_CATALOG (inline minimal copy for script use) ──────────────────────
// We can't easily import from the web app at script runtime because of path aliases.
// This is a flat list of { id, tags } to enable skill matching.

export interface SkillMatchEntry {
  id: string
  tags: string[]
  name: string
}

export const SKILL_MATCH_CATALOG: SkillMatchEntry[] = [
  {
    id: 'bash-executor',
    name: 'Bash Executor',
    tags: ['shell', 'terminal', 'scripting', 'automation'],
  },
  {
    id: 'code-search',
    name: 'Code Search',
    tags: ['grep', 'ast', 'codebase', 'analysis', 'search'],
  },
  {
    id: 'test-runner',
    name: 'Test Runner',
    tags: ['testing', 'jest', 'vitest', 'pytest', 'ci', 'coverage'],
  },
  {
    id: 'python-executor',
    name: 'Python Executor',
    tags: ['python', 'scripting', 'eval', 'runtime'],
  },
  { id: 'linter', name: 'Linter', tags: ['lint', 'eslint', 'style', 'quality', 'formatting'] },
  { id: 'web-search', name: 'Web Search', tags: ['search', 'internet', 'research', 'google'] },
  {
    id: 'web-scraper',
    name: 'Web Scraper',
    tags: ['scraping', 'extraction', 'html', 'parsing', 'dom'],
  },
  { id: 'pdf-reader', name: 'PDF Reader', tags: ['pdf', 'extraction', 'ocr', 'documents'] },
  { id: 'api-tester', name: 'API Tester', tags: ['http', 'rest', 'api', 'testing', 'requests'] },
  { id: 'rss-reader', name: 'RSS Reader', tags: ['rss', 'atom', 'feeds', 'monitoring', 'news'] },
  {
    id: 'csv-analyzer',
    name: 'CSV Analyzer',
    tags: ['csv', 'tsv', 'tabular', 'analytics', 'datasets'],
  },
  {
    id: 'json-transformer',
    name: 'JSON Transformer',
    tags: ['json', 'transform', 'jmespath', 'reshape'],
  },
  { id: 'sql-query', name: 'SQL Query', tags: ['sql', 'database', 'sqlite', 'postgres', 'mysql'] },
  {
    id: 'spreadsheet-reader',
    name: 'Spreadsheet Reader',
    tags: ['excel', 'xlsx', 'spreadsheet', 'google-sheets'],
  },
  {
    id: 'data-visualizer',
    name: 'Data Visualizer',
    tags: ['charts', 'graphs', 'visualization', 'svg', 'png'],
  },
  { id: 'email-draft', name: 'Email Draft', tags: ['email', 'compose', 'templates', 'messaging'] },
  {
    id: 'slack-poster',
    name: 'Slack Poster',
    tags: ['slack', 'messaging', 'notifications', 'channels'],
  },
  {
    id: 'notification-sender',
    name: 'Notification Sender',
    tags: ['notifications', 'push', 'webhooks', 'alerts'],
  },
  {
    id: 'calendar-manager',
    name: 'Calendar Manager',
    tags: ['calendar', 'events', 'scheduling', 'google', 'outlook'],
  },
  {
    id: 'meeting-notes',
    name: 'Meeting Notes',
    tags: ['meetings', 'transcription', 'summary', 'notes'],
  },
  { id: 'file-reader', name: 'File Reader', tags: ['read', 'fs', 'stream', 'files'] },
  { id: 'file-writer', name: 'File Writer', tags: ['write', 'fs', 'create', 'atomic'] },
  {
    id: 'image-resizer',
    name: 'Image Resizer',
    tags: ['image', 'resize', 'crop', 'convert', 'sharp'],
  },
  {
    id: 'zip-handler',
    name: 'Zip Handler',
    tags: ['zip', 'tar', 'archive', 'compress', 'extract'],
  },
  {
    id: 'markdown-renderer',
    name: 'Markdown Renderer',
    tags: ['markdown', 'render', 'html', 'pdf', 'highlight'],
  },
  {
    id: 'quiz-generator',
    name: 'Quiz Generator',
    tags: ['quiz', 'flashcards', 'education', 'learning'],
  },
  {
    id: 'note-taker',
    name: 'Note Taker',
    tags: ['notes', 'organize', 'tagging', 'knowledge-base'],
  },
  {
    id: 'citation-formatter',
    name: 'Citation Formatter',
    tags: ['citations', 'bibliography', 'apa', 'mla', 'academic'],
  },
  {
    id: 'trend-analyzer',
    name: 'Trend Analyzer',
    tags: ['trends', 'statistics', 'time-series', 'patterns'],
  },
  { id: 'summarizer', name: 'Summarizer', tags: ['summary', 'condensing', 'key-points', 'tldr'] },
]

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GitTreeItem {
  path: string
  mode: string
  type: string
  sha: string
  size?: number
  url: string
}

export interface ProcessedAgent {
  id: string
  name: string
  role: string
  emoji: string
  color: string
  description: string
  source: 'agency-agents'
  sourceUrl: string
  domain: AgencyDomain
  subDomain?: string
  category: string
  tags: string[]
  skillIds: string[]
  soulTemplate: string
  identityTemplate: string
  toolsTemplate: string
}

// ─── String utilities ────────────────────────────────────────────────────────

/** Convert string to kebab-case slug */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Convert kebab-case slug to Title Case */
export function titleCase(str: string): string {
  return str.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

/** Fetch the full recursive git tree for the pinned SHA */
export async function fetchAgentTree(): Promise<GitTreeItem[]> {
  const url = `https://api.github.com/repos/${AGENCY_AGENTS_REPO}/git/trees/${AGENCY_AGENTS_SHA}?recursive=1`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'clawboo-ingest-script',
      Accept: 'application/vnd.github.v3+json',
    },
  })
  if (!res.ok) {
    throw new Error(`GitHub tree API returned ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as { tree: GitTreeItem[] }
  return data.tree
}

/** Filter tree items to .md files in the 13 target domains */
export function filterAgentFiles(tree: GitTreeItem[]): GitTreeItem[] {
  return tree.filter((item) => {
    if (item.type !== 'blob') return false
    if (!item.path.endsWith('.md')) return false
    const parts = item.path.split('/')
    const topFolder = parts[0] as AgencyDomain
    return (TARGET_DOMAINS as readonly string[]).includes(topFolder)
  })
}

/** Fetch raw content of a file at the pinned SHA */
export async function fetchRawFile(filePath: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${AGENCY_AGENTS_REPO}/${AGENCY_AGENTS_SHA}/${filePath}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'clawboo-ingest-script' },
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch ${filePath}: ${res.status}`)
  }
  return res.text()
}

/** Run N async tasks with concurrency limit */
export async function pLimit<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = []
  let index = 0

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++
      results[i] = await tasks[i]()
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

// ─── Content extraction ───────────────────────────────────────────────────────

const SOUL_HEADINGS = [
  /^## Core Mission/i,
  /^## Critical (?:Rules|Guardrails)/i,
  /^## Communication Style/i,
  /^## Key Responsibilities/i,
  /^## Core Philosophy/i,
]

/**
 * Extract soul template from markdown content.
 * Grabs up to 3 matching sections (heading + body until next ## heading).
 * Falls back to first 400 chars + TODO marker if no sections found.
 */
export function extractSoul(content: string, agentId: string): string {
  const lines = content.split('\n')
  const sections: string[] = []
  let i = 0

  while (i < lines.length && sections.length < 3) {
    const line = lines[i]
    const matchedHeading = SOUL_HEADINGS.some((re) => re.test(line))
    if (matchedHeading) {
      const sectionLines = [line]
      i++
      while (i < lines.length && !lines[i].match(/^## /)) {
        sectionLines.push(lines[i])
        i++
      }
      // Trim trailing blank lines from section
      while (sectionLines.length > 1 && sectionLines[sectionLines.length - 1].trim() === '') {
        sectionLines.pop()
      }
      sections.push(sectionLines.join('\n'))
    } else {
      i++
    }
  }

  if (sections.length === 0) {
    const fallback = content.slice(0, 400).trimEnd()
    console.warn(`[SOUL_FALLBACK] ${agentId}: no matching sections found, using first 400 chars`)
    return `${fallback}\n\n<!-- TODO: review soul extraction -->`
  }

  return sections.join('\n\n')
}

/**
 * Match skills from SKILL_CATALOG against agent content.
 * Uses word-boundary matching on skill tags (lowercased).
 */
export function matchSkillIds(content: string): string[] {
  const lower = content.toLowerCase()
  const matched: string[] = []

  for (const skill of SKILL_MATCH_CATALOG) {
    const hasMatch = skill.tags.some((tag) => {
      const re = new RegExp(`\\b${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      return re.test(lower)
    })
    if (hasMatch) {
      matched.push(skill.id)
    }
  }

  return matched
}

/**
 * Build toolsTemplate from matched skill IDs.
 */
export function buildToolsTemplate(skillIds: string[]): string {
  if (skillIds.length === 0) {
    return '# TOOLS\n\n## Skills\n'
  }
  return `# TOOLS\n\n## Skills\n${skillIds.map((id) => `- ${id}`).join('\n')}\n`
}

/**
 * Extract a 1–2 sentence description from agent content.
 * Finds the first non-empty, non-heading line with > 40 chars.
 */
export function extractDescription(content: string, role: string): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length > 40 && !trimmed.startsWith('#') && !trimmed.startsWith('-')) {
      // Truncate to ~160 chars for card display
      return trimmed.length > 160 ? trimmed.slice(0, 157) + '...' : trimmed
    }
  }
  return `${role} agent for your team.`
}

// ─── Per-file processing ─────────────────────────────────────────────────────

/**
 * Process a single agent .md file into a ProcessedAgent record.
 */
export function processAgentFile(filePath: string, content: string): ProcessedAgent {
  const parts = filePath.split('/')
  const domain = parts[0] as AgencyDomain
  const filename = parts[parts.length - 1].replace(/\.md$/, '')
  const subDomain = parts.length > 2 ? parts[1] : undefined

  // For game-development subdirectories, prefix subdomain to avoid ID collisions
  const idSuffix =
    subDomain && domain === 'game-development'
      ? `${slugify(subDomain)}-${slugify(filename)}`
      : slugify(filename)
  const id = `agency-${idSuffix}`

  const role = titleCase(slugify(filename).replace(/-/g, ' '))
  const name = `${role} Boo`

  const meta = DOMAIN_META[domain]
  const skillIds = matchSkillIds(content)

  return {
    id,
    name,
    role,
    emoji: meta.emoji,
    color: meta.color,
    description: extractDescription(content, role),
    source: 'agency-agents',
    sourceUrl: `https://github.com/${AGENCY_AGENTS_REPO}/blob/${AGENCY_AGENTS_SHA}/${filePath}`,
    domain,
    subDomain,
    category: meta.category,
    tags: [
      domain,
      ...slugify(filename)
        .split('-')
        .filter((t) => t.length > 2),
    ],
    skillIds,
    soulTemplate: extractSoul(content, id),
    identityTemplate: content,
    toolsTemplate: buildToolsTemplate(skillIds),
  }
}

// ─── File generation ─────────────────────────────────────────────────────────

const FILE_HEADER = `// MIT License — content sourced from github.com/msitarzewski/agency-agents
// Commit: ${AGENCY_AGENTS_SHA}
// See THIRD_PARTY_NOTICES.md for full license text.
//
// AUTO-GENERATED — do not edit manually.
// Regenerate: pnpm ingest:marketplace

import type { AgentCatalogEntry } from '@/features/teams/types'`

/**
 * Render a single domain's TypeScript file content.
 */
export function renderDomainFile(domain: AgencyDomain, agents: ProcessedAgent[]): string {
  const exportName = DOMAIN_EXPORT_NAME[domain]
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id))

  const entries = sorted.map((a) => {
    return `  {
    id: ${JSON.stringify(a.id)},
    name: ${JSON.stringify(a.name)},
    role: ${JSON.stringify(a.role)},
    emoji: ${JSON.stringify(a.emoji)},
    color: ${JSON.stringify(a.color)},
    description: ${JSON.stringify(a.description)},
    source: 'agency-agents',
    sourceUrl: ${JSON.stringify(a.sourceUrl)},
    domain: ${JSON.stringify(a.domain)},${a.subDomain ? `\n    subDomain: ${JSON.stringify(a.subDomain)},` : ''}
    category: ${JSON.stringify(a.category)},
    tags: ${JSON.stringify(a.tags)},
    skillIds: ${JSON.stringify(a.skillIds)},
    soulTemplate: ${JSON.stringify(a.soulTemplate)},
    identityTemplate: ${JSON.stringify(a.identityTemplate)},
    toolsTemplate: ${JSON.stringify(a.toolsTemplate)},
  }`
  })

  return `${FILE_HEADER}

export const ${exportName}: AgentCatalogEntry[] = [
${entries.join(',\n')}
]
`
}

/**
 * Render the agency/index.ts file that concatenates all 13 domain arrays.
 */
export function renderAgencyIndex(): string {
  const reExports = TARGET_DOMAINS.map(
    (d) => `export { ${DOMAIN_EXPORT_NAME[d]} } from './${d}'`,
  ).join('\n')

  const spreads = TARGET_DOMAINS.map((d) => `  ...${DOMAIN_EXPORT_NAME[d]}`).join(',\n')

  return `// AUTO-GENERATED — do not edit manually.
// Regenerate: pnpm ingest:marketplace

import type { AgentCatalogEntry } from '@/features/teams/types'
${TARGET_DOMAINS.map((d) => `import { ${DOMAIN_EXPORT_NAME[d]} } from './${d}'`).join('\n')}

${reExports}

export const AGENCY_AGENTS: AgentCatalogEntry[] = [
${spreads},
]
`
}

// ─── Output paths ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, '../..')
export const AGENTS_DIR = path.join(REPO_ROOT, 'apps/web/src/features/marketplace/agents')
export const AGENCY_DIR = path.join(AGENTS_DIR, 'agency')

export function domainFilePath(domain: AgencyDomain): string {
  return path.join(AGENCY_DIR, `${domain}.ts`)
}

export function agencyIndexPath(): string {
  return path.join(AGENCY_DIR, 'index.ts')
}

export function agentsIndexPath(): string {
  return path.join(AGENTS_DIR, 'index.ts')
}
