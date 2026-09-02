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

// ─── Builtin skills ─────────────────────────────────────────────────────────────
//
// A hand-curated, in-repo catalog — there is no external registry, fetch, or
// vetting behind these entries. "Adding" a skill records a curated annotation on
// the agent (surfaced on the Ghost Graph + Capabilities dashboard); it does not
// provision a runtime tool. So the catalog carries only honest, first-party fields
// (name / description / category / tags) — no trust score, publisher, or version.
//
// These are the BUILTINS. A pack may contribute its own skills; the merged view
// is `buildSkillRegistry` below, where a builtin always wins a collision.

export const BUILTIN_SKILLS: CatalogSkill[] = [
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

  // ── playbooks (14) ──────────────────────────────────────────────────────────
  //
  // A SECOND SHAPE OF SKILL, added deliberately. The thirty entries above are
  // TOOL-shaped: each one names a capability an agent reaches for (run a query,
  // resize an image). These fourteen are PROCESS-shaped: each names a way of
  // working an agent commits to before it touches anything (find the root cause
  // first, write the failing test first, prove the claim before making it).
  //
  // Both shapes are annotations, not provisioning - the note at the top of this
  // file applies unchanged. What a playbook adds is a legible answer to "how
  // does this agent approach the work", which a list of tools cannot express.
  //
  // The category union stays CLOSED at the six values the Ghost Graph shares, so
  // playbooks fall under 'code' when they are specific to changing code and
  // 'other' when they are not. That is why 'other' is the biggest group here.
  //
  // Adapted from the process skills in obra/superpowers (MIT); the wording is
  // Clawboo's own. See THIRD_PARTY_NOTICES.md for the notice and the pinned ref.
  {
    id: 'brainstorming',
    name: 'Brainstorming',
    description:
      'Turn a vague request into an agreed design by exploring intent and constraints before any building starts.',
    category: 'other',
    tags: ['design', 'requirements', 'discovery', 'process'],
  },
  {
    id: 'plan-writing',
    name: 'Plan Writing',
    description:
      'Turn an agreed design into a written plan of small, independently verifiable steps with named files and checks.',
    category: 'other',
    tags: ['planning', 'specification', 'decomposition', 'process'],
  },
  {
    id: 'plan-execution',
    name: 'Plan Execution',
    description:
      'Work a written plan step by step, running the verification each step names before moving to the next.',
    category: 'other',
    tags: ['execution', 'planning', 'checkpoints', 'process'],
  },
  {
    id: 'subagent-delegation',
    name: 'Subagent Delegation',
    description:
      'Hand each task to a fresh subagent with purpose-built context, then review what comes back before continuing.',
    category: 'other',
    tags: ['delegation', 'subagents', 'context', 'process'],
  },
  {
    id: 'parallel-dispatch',
    name: 'Parallel Dispatch',
    description:
      'Split unrelated problems across concurrent investigators, one per independent domain, and merge their findings.',
    category: 'other',
    tags: ['parallel', 'delegation', 'investigation', 'process'],
  },
  {
    id: 'verification-before-completion',
    name: 'Verification Before Completion',
    description:
      'Prove a claim of done by running the check and reading its output before reporting the work finished.',
    category: 'other',
    tags: ['verification', 'evidence', 'quality', 'process'],
  },
  {
    id: 'skill-authoring',
    name: 'Skill Authoring',
    description:
      'Write a reusable playbook by watching the work fail without it, then documenting exactly what closes the gap.',
    category: 'other',
    tags: ['documentation', 'playbooks', 'authoring', 'process'],
  },
  {
    id: 'playbook-routing',
    name: 'Playbook Routing',
    description:
      'Choose the playbook a task calls for and say so before acting, so the approach is visible from the first move.',
    category: 'other',
    tags: ['routing', 'playbooks', 'announcement', 'process'],
  },
  {
    id: 'systematic-debugging',
    name: 'Systematic Debugging',
    description:
      'Reproduce a failure and find its root cause from evidence before proposing any fix.',
    category: 'code',
    tags: ['debugging', 'root-cause', 'reproduction', 'process'],
  },
  {
    id: 'test-driven-development',
    name: 'Test-Driven Development',
    description:
      'Write the failing test first, watch it fail, then write the smallest change that makes it pass.',
    category: 'code',
    tags: ['testing', 'tdd', 'red-green', 'process'],
  },
  {
    id: 'code-review-request',
    name: 'Code Review Request',
    description:
      'Package a change for review with the diff, the intent, and the acceptance criteria a reviewer needs.',
    category: 'code',
    tags: ['review', 'handoff', 'quality', 'process'],
  },
  {
    id: 'code-review-response',
    name: 'Code Review Response',
    description:
      'Evaluate review feedback on its technical merits, check each point against the code, and answer with reasoning.',
    category: 'code',
    tags: ['review', 'feedback', 'rigour', 'process'],
  },
  {
    id: 'worktree-isolation',
    name: 'Worktree Isolation',
    description:
      'Give risky or long-running work its own isolated workspace so the main checkout stays clean.',
    category: 'code',
    tags: ['git', 'worktree', 'isolation', 'process'],
  },
  {
    id: 'branch-wrap-up',
    name: 'Branch Wrap-Up',
    description:
      'Close out finished branch work in order: a green suite, then the integration choice, then cleanup.',
    category: 'code',
    tags: ['git', 'branch', 'integration', 'process'],
  },
]

// ─── The merged registry ────────────────────────────────────────────────────────

/** Every category a skill may claim. Anything else is coerced to 'other'. */
export const SKILL_CATEGORIES: ReadonlySet<SkillCategory> = new Set<SkillCategory>([
  'code',
  'web',
  'data',
  'comm',
  'file',
  'other',
])

/**
 * Merge pack-contributed skills with the builtins. HALF-OPEN: a pack may ADD a
 * skill, but it may not REDEFINE one Clawboo ships.
 *
 * Builtin-wins is applied last so it is unconditional. Between two packs, the
 * FIRST occurrence wins, which makes the result independent of how many times a
 * caller re-runs the merge.
 *
 * `category` is coerced rather than rejected: an unrecognised category on an
 * otherwise good skill should degrade to 'other', not drop the entry — the
 * Ghost Graph's `SkillCategory` is deliberately closed and cannot grow to meet a
 * pack.
 */
export function buildSkillRegistry(packSkills: readonly CatalogSkill[]): Map<string, CatalogSkill> {
  const merged = new Map<string, CatalogSkill>()
  for (const s of packSkills) {
    if (merged.has(s.id)) continue
    merged.set(s.id, {
      ...s,
      category: SKILL_CATEGORIES.has(s.category) ? s.category : 'other',
    })
  }
  for (const s of BUILTIN_SKILLS) merged.set(s.id, s)
  return merged
}

/**
 * Pack skill ids that collide with a builtin id.
 *
 * Builtin-wins alone is not enough to make a collision harmless. `POST
 * /api/skills` validates field TYPES, not membership, so a divergent row for a
 * colliding id can still be written by direct POST and would then disagree with
 * the merged registry the UI renders. Catching it at PACK-BUILD time puts the
 * collision in front of a reviewer instead.
 */
export function builtinSkillCollisions(packSkills: readonly { id: string }[]): string[] {
  const builtin = new Set(BUILTIN_SKILLS.map((s) => s.id))
  return [...new Set(packSkills.map((s) => s.id).filter((id) => builtin.has(id)))]
}

/** Throws when a pack redefines a builtin skill id. Called by `scripts/catalog/validate.ts`. */
export function assertNoBuiltinSkillCollision(packSkills: readonly { id: string }[]): void {
  const collisions = builtinSkillCollisions(packSkills)
  if (collisions.length > 0) {
    throw new Error(
      `Pack skill ids collide with Clawboo builtins: ${collisions.join(', ')}. ` +
        'A builtin always wins the merge, so these entries would be silently discarded. ' +
        'Rename them (a pack-scoped prefix is the usual fix).',
    )
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Look up a builtin skill by ID. */
export function getCatalogSkill(id: string): CatalogSkill | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id)
}

/** Filter catalog by search text (matches name, description, tags). */
export function searchCatalog(query: string): CatalogSkill[] {
  if (!query.trim()) return BUILTIN_SKILLS
  const q = query.toLowerCase()
  return BUILTIN_SKILLS.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.includes(q)),
  )
}
