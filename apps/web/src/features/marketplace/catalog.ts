import type { SkillCategory } from '@/features/graph/types'

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface CatalogSkill {
  /** Kebab-case unique ID — matches the skill name that would appear in TOOLS.md */
  id: string
  /** Human-readable display name */
  name: string
  /** Short 1–2 sentence description */
  description: string
  /** Skill category */
  category: SkillCategory
  /** Search tags */
  tags: string[]
}

// ─── Catalog ────────────────────────────────────────────────────────────────────
//
// A hand-curated, in-repo catalog — there is no external registry, fetch, or
// vetting behind these entries. "Adding" a skill records a curated annotation on
// the agent (surfaced on the Ghost Graph + Capabilities dashboard); it does not
// provision a runtime tool. So the catalog carries only honest, first-party fields
// (name / description / category / tags) — no trust score, publisher, or version.

export const SKILL_CATALOG: CatalogSkill[] = [
  // ── code (5) ────────────────────────────────────────────────────────────────
  {
    id: 'bash-executor',
    name: 'Bash Executor',
    description: 'Run shell commands and scripts with sandboxed execution and timeout controls.',
    category: 'code',
    tags: ['shell', 'terminal', 'scripting', 'automation'],
  },
  {
    id: 'code-search',
    name: 'Code Search',
    description: 'Grep and AST-aware search across codebases with support for 20+ languages.',
    category: 'code',
    tags: ['grep', 'ast', 'codebase', 'analysis', 'search'],
  },
  {
    id: 'test-runner',
    name: 'Test Runner',
    description:
      'Execute test suites across frameworks (Jest, Vitest, pytest) and report coverage.',
    category: 'code',
    tags: ['testing', 'jest', 'vitest', 'pytest', 'ci', 'coverage'],
  },
  {
    id: 'python-executor',
    name: 'Python Executor',
    description:
      'Run Python scripts and evaluate expressions in an isolated runtime with pip support.',
    category: 'code',
    tags: ['python', 'scripting', 'eval', 'runtime'],
  },
  {
    id: 'linter',
    name: 'Linter',
    description:
      'Lint code for style issues and common errors across JavaScript, TypeScript, and Python.',
    category: 'code',
    tags: ['lint', 'eslint', 'style', 'quality', 'formatting'],
  },

  // ── web (5) ─────────────────────────────────────────────────────────────────
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web and return structured results with snippet extraction.',
    category: 'web',
    tags: ['search', 'internet', 'research', 'google'],
  },
  {
    id: 'web-scraper',
    name: 'Web Scraper',
    description: 'Extract structured data from web pages via CSS selectors and XPath queries.',
    category: 'web',
    tags: ['scraping', 'extraction', 'html', 'parsing', 'dom'],
  },
  {
    id: 'pdf-reader',
    name: 'PDF Reader',
    description: 'Extract text, tables, and metadata from PDF documents with OCR fallback.',
    category: 'web',
    tags: ['pdf', 'extraction', 'ocr', 'documents'],
  },
  {
    id: 'api-tester',
    name: 'API Tester',
    description: 'Send HTTP requests and validate API responses with assertion support.',
    category: 'web',
    tags: ['http', 'rest', 'api', 'testing', 'requests'],
  },
  {
    id: 'rss-reader',
    name: 'RSS Reader',
    description: 'Parse and monitor RSS/Atom feeds with filtering and keyword alerts.',
    category: 'web',
    tags: ['rss', 'atom', 'feeds', 'monitoring', 'news'],
  },

  // ── data (5) ────────────────────────────────────────────────────────────────
  {
    id: 'csv-analyzer',
    name: 'CSV Analyzer',
    description: 'Parse, query, and summarize CSV/TSV datasets with pivot and aggregation support.',
    category: 'data',
    tags: ['csv', 'tsv', 'tabular', 'analytics', 'datasets'],
  },
  {
    id: 'json-transformer',
    name: 'JSON Transformer',
    description: 'Transform, flatten, and reshape JSON structures with JMESPath expressions.',
    category: 'data',
    tags: ['json', 'transform', 'jmespath', 'reshape'],
  },
  {
    id: 'sql-query',
    name: 'SQL Query',
    description: 'Run SQL queries against SQLite, PostgreSQL, and MySQL databases.',
    category: 'data',
    tags: ['sql', 'database', 'sqlite', 'postgres', 'mysql'],
  },
  {
    id: 'spreadsheet-reader',
    name: 'Spreadsheet Reader',
    description: 'Read and extract data from Excel (.xlsx) and Google Sheets files.',
    category: 'data',
    tags: ['excel', 'xlsx', 'spreadsheet', 'google-sheets'],
  },
  {
    id: 'data-visualizer',
    name: 'Data Visualizer',
    description: 'Generate charts and graphs from datasets as SVG or PNG images.',
    category: 'data',
    tags: ['charts', 'graphs', 'visualization', 'svg', 'png'],
  },

  // ── comm (5) ────────────────────────────────────────────────────────────────
  {
    id: 'email-draft',
    name: 'Email Draft',
    description: 'Compose and format email drafts with templates and variable substitution.',
    category: 'comm',
    tags: ['email', 'compose', 'templates', 'messaging'],
  },
  {
    id: 'slack-poster',
    name: 'Slack Poster',
    description: 'Send messages, thread replies, and upload files to Slack channels.',
    category: 'comm',
    tags: ['slack', 'messaging', 'notifications', 'channels'],
  },
  {
    id: 'notification-sender',
    name: 'Notification Sender',
    description: 'Push notifications via webhooks, Pushover, or Ntfy with priority levels.',
    category: 'comm',
    tags: ['notifications', 'push', 'webhooks', 'alerts'],
  },
  {
    id: 'calendar-manager',
    name: 'Calendar Manager',
    description: 'Create, update, and query calendar events across Google and Outlook.',
    category: 'comm',
    tags: ['calendar', 'events', 'scheduling', 'google', 'outlook'],
  },
  {
    id: 'meeting-notes',
    name: 'Meeting Notes',
    description: 'Transcribe audio recordings and generate structured meeting summaries.',
    category: 'comm',
    tags: ['meetings', 'transcription', 'summary', 'notes'],
  },

  // ── file (5) ────────────────────────────────────────────────────────────────
  {
    id: 'file-reader',
    name: 'File Reader',
    description: 'Read files in various formats with streaming support for large files.',
    category: 'file',
    tags: ['read', 'fs', 'stream', 'files'],
  },
  {
    id: 'file-writer',
    name: 'File Writer',
    description: 'Write and create files with atomic operations and directory auto-creation.',
    category: 'file',
    tags: ['write', 'fs', 'create', 'atomic'],
  },
  {
    id: 'image-resizer',
    name: 'Image Resizer',
    description: 'Resize, crop, and convert images between formats using sharp.',
    category: 'file',
    tags: ['image', 'resize', 'crop', 'convert', 'sharp'],
  },
  {
    id: 'zip-handler',
    name: 'Zip Handler',
    description: 'Create, extract, and inspect ZIP and tar.gz archives.',
    category: 'file',
    tags: ['zip', 'tar', 'archive', 'compress', 'extract'],
  },
  {
    id: 'markdown-renderer',
    name: 'Markdown Renderer',
    description:
      'Convert Markdown to HTML, PDF, or styled terminal output with syntax highlighting.',
    category: 'file',
    tags: ['markdown', 'render', 'html', 'pdf', 'highlight'],
  },

  // ── other (5) ───────────────────────────────────────────────────────────────
  {
    id: 'quiz-generator',
    name: 'Quiz Generator',
    description: 'Generate flashcards and quizzes from study material with spaced repetition.',
    category: 'other',
    tags: ['quiz', 'flashcards', 'education', 'learning'],
  },
  {
    id: 'note-taker',
    name: 'Note Taker',
    description: 'Capture, organize, and search notes with automatic tagging and linking.',
    category: 'other',
    tags: ['notes', 'organize', 'tagging', 'knowledge-base'],
  },
  {
    id: 'citation-formatter',
    name: 'Citation Formatter',
    description: 'Format academic citations in APA, MLA, Chicago, and BibTeX styles.',
    category: 'other',
    tags: ['citations', 'bibliography', 'apa', 'mla', 'academic'],
  },
  {
    id: 'trend-analyzer',
    name: 'Trend Analyzer',
    description: 'Detect patterns and trends in time-series data with statistical methods.',
    category: 'other',
    tags: ['trends', 'statistics', 'time-series', 'patterns'],
  },
  {
    id: 'summarizer',
    name: 'Summarizer',
    description: 'Condense long documents into key points with configurable detail levels.',
    category: 'other',
    tags: ['summary', 'condensing', 'key-points', 'tldr'],
  },
]

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Look up a catalog skill by ID. */
export function getCatalogSkill(id: string): CatalogSkill | undefined {
  return SKILL_CATALOG.find((s) => s.id === id)
}

/** Filter catalog by search text (matches name, description, tags). */
export function searchCatalog(query: string): CatalogSkill[] {
  if (!query.trim()) return SKILL_CATALOG
  const q = query.toLowerCase()
  return SKILL_CATALOG.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.includes(q)),
  )
}
