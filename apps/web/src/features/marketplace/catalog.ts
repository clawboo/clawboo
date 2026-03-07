import type { SkillCategory } from '@/features/graph/types'

// ─── Types ──────────────────────────────────────────────────────────────────────

export type SkillSource = 'clawhub' | 'skill.sh' | 'verified' | 'local'

export interface CatalogSkill {
  /** Kebab-case unique ID — matches the skill name that would appear in TOOLS.md */
  id: string
  /** Human-readable display name */
  name: string
  /** Short 1–2 sentence description */
  description: string
  /** Skill category */
  category: SkillCategory
  /** Where this skill comes from */
  source: SkillSource
  /** Trust score 0–100 */
  trustScore: number
  /** Semver version string */
  version: string
  /** Publisher / author name */
  author: string
  /** Search tags */
  tags: string[]
}

// ─── Catalog ────────────────────────────────────────────────────────────────────

export const SKILL_CATALOG: CatalogSkill[] = [
  // ── code (5) ────────────────────────────────────────────────────────────────
  {
    id: 'bash-executor',
    name: 'Bash Executor',
    description: 'Run shell commands and scripts with sandboxed execution and timeout controls.',
    category: 'code',
    source: 'verified',
    trustScore: 98,
    version: '1.2.0',
    author: 'OpenClaw',
    tags: ['shell', 'terminal', 'scripting', 'automation'],
  },
  {
    id: 'code-search',
    name: 'Code Search',
    description: 'Grep and AST-aware search across codebases with support for 20+ languages.',
    category: 'code',
    source: 'verified',
    trustScore: 97,
    version: '1.0.3',
    author: 'OpenClaw',
    tags: ['grep', 'ast', 'codebase', 'analysis', 'search'],
  },
  {
    id: 'test-runner',
    name: 'Test Runner',
    description:
      'Execute test suites across frameworks (Jest, Vitest, pytest) and report coverage.',
    category: 'code',
    source: 'verified',
    trustScore: 96,
    version: '1.1.0',
    author: 'OpenClaw',
    tags: ['testing', 'jest', 'vitest', 'pytest', 'ci', 'coverage'],
  },
  {
    id: 'python-executor',
    name: 'Python Executor',
    description:
      'Run Python scripts and evaluate expressions in an isolated runtime with pip support.',
    category: 'code',
    source: 'clawhub',
    trustScore: 88,
    version: '0.9.2',
    author: 'community/py-tools',
    tags: ['python', 'scripting', 'eval', 'runtime'],
  },
  {
    id: 'linter',
    name: 'Linter',
    description:
      'Lint code for style issues and common errors across JavaScript, TypeScript, and Python.',
    category: 'code',
    source: 'clawhub',
    trustScore: 84,
    version: '1.0.0',
    author: 'community/lint-suite',
    tags: ['lint', 'eslint', 'style', 'quality', 'formatting'],
  },

  // ── web (5) ─────────────────────────────────────────────────────────────────
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web and return structured results with snippet extraction.',
    category: 'web',
    source: 'verified',
    trustScore: 98,
    version: '2.0.1',
    author: 'OpenClaw',
    tags: ['search', 'internet', 'research', 'google'],
  },
  {
    id: 'web-scraper',
    name: 'Web Scraper',
    description: 'Extract structured data from web pages via CSS selectors and XPath queries.',
    category: 'web',
    source: 'clawhub',
    trustScore: 85,
    version: '0.9.1',
    author: 'community/scraper-kit',
    tags: ['scraping', 'extraction', 'html', 'parsing', 'dom'],
  },
  {
    id: 'pdf-reader',
    name: 'PDF Reader',
    description: 'Extract text, tables, and metadata from PDF documents with OCR fallback.',
    category: 'web',
    source: 'clawhub',
    trustScore: 82,
    version: '1.3.0',
    author: 'community/doc-tools',
    tags: ['pdf', 'extraction', 'ocr', 'documents'],
  },
  {
    id: 'api-tester',
    name: 'API Tester',
    description: 'Send HTTP requests and validate API responses with assertion support.',
    category: 'web',
    source: 'skill.sh',
    trustScore: 74,
    version: '0.7.0',
    author: 'skill.sh/webdev',
    tags: ['http', 'rest', 'api', 'testing', 'requests'],
  },
  {
    id: 'rss-reader',
    name: 'RSS Reader',
    description: 'Parse and monitor RSS/Atom feeds with filtering and keyword alerts.',
    category: 'web',
    source: 'skill.sh',
    trustScore: 68,
    version: '0.5.2',
    author: 'skill.sh/feeds',
    tags: ['rss', 'atom', 'feeds', 'monitoring', 'news'],
  },

  // ── data (5) ────────────────────────────────────────────────────────────────
  {
    id: 'csv-analyzer',
    name: 'CSV Analyzer',
    description: 'Parse, query, and summarize CSV/TSV datasets with pivot and aggregation support.',
    category: 'data',
    source: 'clawhub',
    trustScore: 82,
    version: '1.1.0',
    author: 'community/data-tools',
    tags: ['csv', 'tsv', 'tabular', 'analytics', 'datasets'],
  },
  {
    id: 'json-transformer',
    name: 'JSON Transformer',
    description: 'Transform, flatten, and reshape JSON structures with JMESPath expressions.',
    category: 'data',
    source: 'clawhub',
    trustScore: 79,
    version: '0.8.4',
    author: 'community/data-tools',
    tags: ['json', 'transform', 'jmespath', 'reshape'],
  },
  {
    id: 'sql-query',
    name: 'SQL Query',
    description: 'Run SQL queries against SQLite, PostgreSQL, and MySQL databases.',
    category: 'data',
    source: 'verified',
    trustScore: 95,
    version: '1.4.0',
    author: 'OpenClaw',
    tags: ['sql', 'database', 'sqlite', 'postgres', 'mysql'],
  },
  {
    id: 'spreadsheet-reader',
    name: 'Spreadsheet Reader',
    description: 'Read and extract data from Excel (.xlsx) and Google Sheets files.',
    category: 'data',
    source: 'clawhub',
    trustScore: 76,
    version: '0.6.1',
    author: 'community/office-tools',
    tags: ['excel', 'xlsx', 'spreadsheet', 'google-sheets'],
  },
  {
    id: 'data-visualizer',
    name: 'Data Visualizer',
    description: 'Generate charts and graphs from datasets as SVG or PNG images.',
    category: 'data',
    source: 'skill.sh',
    trustScore: 71,
    version: '0.4.0',
    author: 'skill.sh/viz',
    tags: ['charts', 'graphs', 'visualization', 'svg', 'png'],
  },

  // ── comm (5) ────────────────────────────────────────────────────────────────
  {
    id: 'email-draft',
    name: 'Email Draft',
    description: 'Compose and format email drafts with templates and variable substitution.',
    category: 'comm',
    source: 'verified',
    trustScore: 96,
    version: '1.0.2',
    author: 'OpenClaw',
    tags: ['email', 'compose', 'templates', 'messaging'],
  },
  {
    id: 'slack-poster',
    name: 'Slack Poster',
    description: 'Send messages, thread replies, and upload files to Slack channels.',
    category: 'comm',
    source: 'clawhub',
    trustScore: 89,
    version: '1.2.0',
    author: 'community/integrations',
    tags: ['slack', 'messaging', 'notifications', 'channels'],
  },
  {
    id: 'notification-sender',
    name: 'Notification Sender',
    description: 'Push notifications via webhooks, Pushover, or Ntfy with priority levels.',
    category: 'comm',
    source: 'skill.sh',
    trustScore: 65,
    version: '0.3.1',
    author: 'skill.sh/notify',
    tags: ['notifications', 'push', 'webhooks', 'alerts'],
  },
  {
    id: 'calendar-manager',
    name: 'Calendar Manager',
    description: 'Create, update, and query calendar events across Google and Outlook.',
    category: 'comm',
    source: 'clawhub',
    trustScore: 83,
    version: '0.8.0',
    author: 'community/productivity',
    tags: ['calendar', 'events', 'scheduling', 'google', 'outlook'],
  },
  {
    id: 'meeting-notes',
    name: 'Meeting Notes',
    description: 'Transcribe audio recordings and generate structured meeting summaries.',
    category: 'comm',
    source: 'clawhub',
    trustScore: 77,
    version: '0.7.3',
    author: 'community/productivity',
    tags: ['meetings', 'transcription', 'summary', 'notes'],
  },

  // ── file (5) ────────────────────────────────────────────────────────────────
  {
    id: 'file-reader',
    name: 'File Reader',
    description: 'Read files in various formats with streaming support for large files.',
    category: 'file',
    source: 'verified',
    trustScore: 97,
    version: '1.3.0',
    author: 'OpenClaw',
    tags: ['read', 'fs', 'stream', 'files'],
  },
  {
    id: 'file-writer',
    name: 'File Writer',
    description: 'Write and create files with atomic operations and directory auto-creation.',
    category: 'file',
    source: 'verified',
    trustScore: 96,
    version: '1.2.0',
    author: 'OpenClaw',
    tags: ['write', 'fs', 'create', 'atomic'],
  },
  {
    id: 'image-resizer',
    name: 'Image Resizer',
    description: 'Resize, crop, and convert images between formats using sharp.',
    category: 'file',
    source: 'clawhub',
    trustScore: 81,
    version: '0.9.0',
    author: 'community/media-tools',
    tags: ['image', 'resize', 'crop', 'convert', 'sharp'],
  },
  {
    id: 'zip-handler',
    name: 'Zip Handler',
    description: 'Create, extract, and inspect ZIP and tar.gz archives.',
    category: 'file',
    source: 'skill.sh',
    trustScore: 72,
    version: '0.5.0',
    author: 'skill.sh/archive',
    tags: ['zip', 'tar', 'archive', 'compress', 'extract'],
  },
  {
    id: 'markdown-renderer',
    name: 'Markdown Renderer',
    description:
      'Convert Markdown to HTML, PDF, or styled terminal output with syntax highlighting.',
    category: 'file',
    source: 'clawhub',
    trustScore: 78,
    version: '1.0.1',
    author: 'community/doc-tools',
    tags: ['markdown', 'render', 'html', 'pdf', 'highlight'],
  },

  // ── other (5) ───────────────────────────────────────────────────────────────
  {
    id: 'quiz-generator',
    name: 'Quiz Generator',
    description: 'Generate flashcards and quizzes from study material with spaced repetition.',
    category: 'other',
    source: 'clawhub',
    trustScore: 73,
    version: '0.6.0',
    author: 'community/edu-tools',
    tags: ['quiz', 'flashcards', 'education', 'learning'],
  },
  {
    id: 'note-taker',
    name: 'Note Taker',
    description: 'Capture, organize, and search notes with automatic tagging and linking.',
    category: 'other',
    source: 'clawhub',
    trustScore: 80,
    version: '0.9.0',
    author: 'community/productivity',
    tags: ['notes', 'organize', 'tagging', 'knowledge-base'],
  },
  {
    id: 'citation-formatter',
    name: 'Citation Formatter',
    description: 'Format academic citations in APA, MLA, Chicago, and BibTeX styles.',
    category: 'other',
    source: 'skill.sh',
    trustScore: 60,
    version: '0.3.0',
    author: 'skill.sh/academic',
    tags: ['citations', 'bibliography', 'apa', 'mla', 'academic'],
  },
  {
    id: 'trend-analyzer',
    name: 'Trend Analyzer',
    description: 'Detect patterns and trends in time-series data with statistical methods.',
    category: 'other',
    source: 'clawhub',
    trustScore: 75,
    version: '0.7.1',
    author: 'community/data-tools',
    tags: ['trends', 'statistics', 'time-series', 'patterns'],
  },
  {
    id: 'summarizer',
    name: 'Summarizer',
    description: 'Condense long documents into key points with configurable detail levels.',
    category: 'other',
    source: 'clawhub',
    trustScore: 86,
    version: '1.1.0',
    author: 'community/text-tools',
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
