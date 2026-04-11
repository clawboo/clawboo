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

export const AWESOME_OPENCLAW_SHA = '659895e58e2105c6db8fbef39f446c8a786a480c'
export const AWESOME_OPENCLAW_REPO = 'hesamsheikh/awesome-openclaw-usecases'

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
export const AWESOME_OPENCLAW_DIR = path.join(AGENTS_DIR, 'awesome-openclaw')
export const CLAWBOO_DIR = path.join(AGENTS_DIR, 'clawboo')

export function domainFilePath(domain: AgencyDomain): string {
  return path.join(AGENCY_DIR, `${domain}.ts`)
}

export function agencyIndexPath(): string {
  return path.join(AGENCY_DIR, 'index.ts')
}

export function agentsIndexPath(): string {
  return path.join(AGENTS_DIR, 'index.ts')
}

export function awesomeOpenclawFilePath(): string {
  return path.join(AWESOME_OPENCLAW_DIR, 'usecases.ts')
}

export function awesomeOpenclawIndexPath(): string {
  return path.join(AWESOME_OPENCLAW_DIR, 'index.ts')
}

// ─── Awesome OpenClaw ingestion ──────────────────────────────────────────────

export interface AwesomeOpenclawAgent {
  id: string
  name: string
  role: string
  emoji: string
  color: string
  description: string
  source: 'awesome-openclaw'
  sourceUrl: string
  domain: 'openclaw'
  category: string
  tags: string[]
  skillIds: string[]
  soulTemplate: string
  identityTemplate: string
  toolsTemplate: string
}

/** Fixed purple accent for all awesome-openclaw entries */
const AWESOME_OPENCLAW_COLOR = '#A855F7'

/** Category to emoji map for awesome-openclaw usecases */
const AWESOME_CATEGORY_EMOJI: Record<string, string> = {
  research: '🔬',
  content: '✍️',
  marketing: '📣',
  engineering: '⚙️',
  devops: '🛠️',
  ops: '📋',
  sales: '💼',
  support: '🛟',
  product: '🚀',
  education: '📚',
  general: '✨',
}

/** Fetch the full recursive git tree for awesome-openclaw at the pinned SHA */
export async function fetchAwesomeOpenclawTree(): Promise<GitTreeItem[]> {
  const url = `https://api.github.com/repos/${AWESOME_OPENCLAW_REPO}/git/trees/${AWESOME_OPENCLAW_SHA}?recursive=1`
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

/** Filter tree items to .md files under /usecases/ */
export function filterUsecaseFiles(tree: GitTreeItem[]): GitTreeItem[] {
  return tree.filter((item) => {
    if (item.type !== 'blob') return false
    if (!item.path.endsWith('.md')) return false
    return item.path.startsWith('usecases/')
  })
}

/** Fetch raw content of an awesome-openclaw file at the pinned SHA */
export async function fetchAwesomeOpenclawRawFile(filePath: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${AWESOME_OPENCLAW_REPO}/${AWESOME_OPENCLAW_SHA}/${filePath}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'clawboo-ingest-script' },
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch ${filePath}: ${res.status}`)
  }
  return res.text()
}

/**
 * Categorize a usecase by filename + content into one of our TemplateCategory values.
 * Returns one of: research | content | marketing | engineering | devops | ops | sales |
 * support | product | education | general.
 */
export function categorizeUsecase(filename: string, body: string): string {
  const slug = filename.toLowerCase()
  const text = body.toLowerCase()

  if (/research|paper|arxiv|knowledge|brain|semantic|rag/.test(slug)) return 'research'
  if (/content|factory|youtube|video|podcast|social|x-twitter|x-account|latex/.test(slug))
    return 'content'
  if (/market|brief|idea-validator|earnings|polymarket/.test(slug)) return 'marketing'
  if (/game-dev|mini-app|pipeline/.test(slug)) return 'engineering'
  if (/home-server|self-healing|n8n|workflow|dashboard/.test(slug)) return 'devops'
  if (/project-management|state-management|task/.test(slug)) return 'ops'
  if (/crm|sales|customer/.test(slug)) return 'sales'
  if (/support|channel|customer-service|inbox|declutter/.test(slug)) return 'support'
  if (/phone|notification|calendar|family|habit|health|personal|assistant|brief/.test(slug))
    return 'general'
  if (/meeting|notes|todoist|event/.test(slug)) return 'ops'

  // Content fallback heuristics
  if (text.includes('research agent') || text.includes('research team')) return 'research'
  if (text.includes('writing agent') || text.includes('content')) return 'content'

  return 'general'
}

interface UsecaseAgentMention {
  name: string
  role: string
  roleSlug: string
}

/**
 * Extract named agents from a usecase body using three parsing passes.
 * Dedupes within the file by roleSlug (first-wins).
 *
 * Pass 1: ### Agent N: Name (Role) or ## Agent: Name
 * Pass 2: ### Name Agent or #### Name Agent
 * Pass 3: **Name Agent** bold inline mentions
 */
export function parseUsecaseAgents(body: string): UsecaseAgentMention[] {
  const seen = new Set<string>()
  const results: UsecaseAgentMention[] = []

  const addMention = (rawName: string, rawRole: string): void => {
    const name = rawName.trim()
    const role = rawRole.trim()
    if (!name || !role) return
    const roleSlug = slugify(role)
    if (!roleSlug || roleSlug.length < 2) return
    if (seen.has(roleSlug)) return
    seen.add(roleSlug)
    results.push({ name, role, roleSlug })
  }

  // Pass 1: "### Agent N: Name (Role)" or "## Agent: Name"
  const pass1 = /^#{2,4}\s*Agent(?:\s+\d+)?:\s*([^(\n]+?)(?:\s*\(([^)\n]+)\))?\s*$/gm
  let match: RegExpExecArray | null
  while ((match = pass1.exec(body)) !== null) {
    const captureName = match[1].trim()
    const captureRole = (match[2] ?? captureName).trim()
    addMention(captureName, captureRole)
  }

  // Pass 2: "### Name Agent" / "#### Name Agent" — H3/H4 ending in "Agent"
  const pass2 = /^#{3,4}\s+([A-Z][A-Za-z0-9 /&-]*?\s+Agent)\s*:?\s*$/gm
  while ((match = pass2.exec(body)) !== null) {
    const role = match[1].trim()
    addMention(role, role)
  }

  // Pass 3: "**Name Agent**" bold inline mentions
  const pass3 = /\*\*([A-Z][A-Za-z0-9 /&-]{1,40}?\s+Agent)\*\*/g
  while ((match = pass3.exec(body)) !== null) {
    const role = match[1].trim()
    addMention(role, role)
  }

  // Pass 4: bulleted bold workflow phases — "- **Episode Research** — given..."
  // These show up in `## What It Does` sections and act as role definitions for
  // each step of a multi-phase workflow. Scoped to the `## What It Does` section
  // only, to avoid noise from other bulleted bold phrases elsewhere in the file.
  const whatItDoesSection = extractSection(body, /^##\s+What\s+It\s+Does/im)
  if (whatItDoesSection) {
    const pass4 = /^[ \t]*[-*][ \t]+\*\*([^*\n]{2,60}?)\*\*/gm
    while ((match = pass4.exec(whatItDoesSection)) !== null) {
      const rawPhrase = match[1]
        .trim()
        .replace(/[:—–.-]+$/, '')
        .trim()
      if (isValidPhasePhrase(rawPhrase)) {
        addMention(rawPhrase, rawPhrase)
      }
    }
  }

  // Pass 5: "**Label:** content" style inline labels — "**Research:** scans..."
  // Also scoped to `## What It Does` section for signal quality.
  if (whatItDoesSection) {
    const pass5 = /\*\*([A-Z][A-Za-z0-9 &-]{2,40}?):\*\*/g
    while ((match = pass5.exec(whatItDoesSection)) !== null) {
      const rawPhrase = match[1].trim()
      if (isValidPhasePhrase(rawPhrase)) {
        addMention(rawPhrase, rawPhrase)
      }
    }
  }

  return results
}

/** Extract the body of a markdown section (from heading to next H2 or EOF). */
function extractSection(body: string, headingPattern: RegExp): string | null {
  const lines = body.split('\n')
  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      startIdx = i + 1
      break
    }
  }
  if (startIdx === -1) return null
  let endIdx = lines.length
  for (let i = startIdx; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i
      break
    }
  }
  return lines.slice(startIdx, endIdx).join('\n')
}

/**
 * Heuristic filter for a workflow-phase phrase.
 * Looser than isValidRolePhrase() — these can start with a gerund or
 * use sentence-case (e.g. "Self-healing", "Morning briefings"). Still
 * filters out obvious noise.
 */
function isValidPhasePhrase(phrase: string): boolean {
  if (!phrase) return false
  if (!/^[A-Z]/.test(phrase)) return false
  if (/[$0-9]/.test(phrase)) return false
  if (/\./.test(phrase)) return false

  const words = phrase.split(/\s+/)
  if (words.length < 1 || words.length > 5) return false

  const noiseStarts =
    /^(Note|Tip|Warning|Example|Important|Key|Pain|Challenge|Origin|Problem|Based|Inspired|Related|The|Your|My|This|That|Why|How|What|When|Where|Who)\b/i
  if (noiseStarts.test(phrase)) return false

  // Reject extremely vague single-word phrases
  if (words.length === 1) {
    if (!/^[A-Z][a-z]+(?:ing|er|or|ist|ant|ent|tion|ment)$/.test(phrase)) return false
  }

  return true
}

/**
 * Process a single usecase .md file into one or more AwesomeOpenclawAgent entries.
 * Always emits at least one "operator" entry per usecase (guaranteed baseline),
 * plus any named agents discovered by parseUsecaseAgents().
 */
export function processUsecaseFile(filePath: string, content: string): AwesomeOpenclawAgent[] {
  const filename = filePath.replace(/^usecases\//, '').replace(/\.md$/, '')
  const usecaseSlug = slugify(filename)
  const usecaseTitle = titleCase(usecaseSlug)

  const category = categorizeUsecase(filename, content)
  const emoji = AWESOME_CATEGORY_EMOJI[category] ?? '✨'
  const sourceUrl = `https://github.com/${AWESOME_OPENCLAW_REPO}/blob/${AWESOME_OPENCLAW_SHA}/${filePath}`
  const skillIds = matchSkillIds(content)
  const toolsTemplate = buildToolsTemplate(skillIds)
  const description = extractDescription(content, usecaseTitle)

  const mentions = parseUsecaseAgents(content)

  const buildSoulTemplate = (role: string): string => {
    const head = content.slice(0, 400).trimEnd()
    return `# ${role}\n\n${head}\n\n<!-- TODO: review soul extraction -->`
  }

  const entries: AwesomeOpenclawAgent[] = []

  // 1. Per-usecase operator (guaranteed baseline)
  const operatorRole = `${usecaseTitle} Operator`
  entries.push({
    id: `awesome-${usecaseSlug}-operator`,
    name: `${operatorRole} Boo`,
    role: operatorRole,
    emoji,
    color: AWESOME_OPENCLAW_COLOR,
    description,
    source: 'awesome-openclaw',
    sourceUrl,
    domain: 'openclaw',
    category,
    tags: ['openclaw', usecaseSlug, 'operator'],
    skillIds,
    soulTemplate: buildSoulTemplate(operatorRole),
    identityTemplate: content,
    toolsTemplate,
  })

  // 2. Named agents extracted from the usecase body
  for (const mention of mentions) {
    const roleSlug = mention.roleSlug
    if (roleSlug === 'operator') continue // avoid collision with operator id
    const id = `awesome-${usecaseSlug}-${roleSlug}`
    const displayRole = mention.role
    entries.push({
      id,
      name: `${displayRole} Boo`,
      role: displayRole,
      emoji,
      color: AWESOME_OPENCLAW_COLOR,
      description,
      source: 'awesome-openclaw',
      sourceUrl,
      domain: 'openclaw',
      category,
      tags: ['openclaw', usecaseSlug, ...roleSlug.split('-').filter((t) => t.length > 2)],
      skillIds,
      soulTemplate: buildSoulTemplate(displayRole),
      identityTemplate: content,
      toolsTemplate,
    })
  }

  return entries
}

const AWESOME_FILE_HEADER = `// MIT License — content sourced from github.com/hesamsheikh/awesome-openclaw-usecases
// Commit: ${AWESOME_OPENCLAW_SHA}
// See THIRD_PARTY_NOTICES.md for full license text.
//
// AUTO-GENERATED — do not edit manually.
// Regenerate: pnpm ingest:marketplace

import type { AgentCatalogEntry } from '@/features/teams/types'`

/**
 * Render the awesome-openclaw/usecases.ts file containing all extracted agents.
 * Input array is sorted by id for determinism.
 */
export function renderAwesomeOpenclawFile(agents: AwesomeOpenclawAgent[]): string {
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id))

  const entries = sorted.map((a) => {
    return `  {
    id: ${JSON.stringify(a.id)},
    name: ${JSON.stringify(a.name)},
    role: ${JSON.stringify(a.role)},
    emoji: ${JSON.stringify(a.emoji)},
    color: ${JSON.stringify(a.color)},
    description: ${JSON.stringify(a.description)},
    source: 'awesome-openclaw',
    sourceUrl: ${JSON.stringify(a.sourceUrl)},
    domain: 'openclaw',
    category: ${JSON.stringify(a.category)},
    tags: ${JSON.stringify(a.tags)},
    skillIds: ${JSON.stringify(a.skillIds)},
    soulTemplate: ${JSON.stringify(a.soulTemplate)},
    identityTemplate: ${JSON.stringify(a.identityTemplate)},
    toolsTemplate: ${JSON.stringify(a.toolsTemplate)},
  }`
  })

  return `${AWESOME_FILE_HEADER}

export const AWESOME_OPENCLAW_USECASES: AgentCatalogEntry[] = [
${entries.join(',\n')}
]
`
}

/**
 * Render the awesome-openclaw/index.ts file.
 */
export function renderAwesomeOpenclawIndex(): string {
  return `// AUTO-GENERATED — do not edit manually.
// Regenerate: pnpm ingest:marketplace

import type { AgentCatalogEntry } from '@/features/teams/types'
import { AWESOME_OPENCLAW_USECASES } from './usecases'

export { AWESOME_OPENCLAW_USECASES } from './usecases'

export const AWESOME_OPENCLAW_AGENTS: AgentCatalogEntry[] = [...AWESOME_OPENCLAW_USECASES]
`
}
