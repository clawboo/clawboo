import type { ParsedSkill, ParsedResource, SkillCategory } from '../types'

// ─── Known external services (become ResourceNodes, not SkillNodes) ───────────

const KNOWN_RESOURCES = new Set([
  'github',
  'gitlab',
  'slack',
  'telegram',
  'discord',
  'email',
  'gmail',
  'notion',
  'dropbox',
  'gdrive',
  'google drive',
  'jira',
  'linear',
  'twitter',
  'x',
  'youtube',
  'trello',
  'airtable',
  'zapier',
  'stripe',
  'twilio',
  'sendgrid',
  'hubspot',
  'salesforce',
  'zendesk',
])

const RESOURCE_ICONS: Record<string, string> = {
  github: '🐙',
  gitlab: '🦊',
  slack: '💬',
  telegram: '✈️',
  discord: '🎮',
  email: '📧',
  gmail: '📧',
  notion: '📋',
  dropbox: '📦',
  gdrive: '📁',
  'google drive': '📁',
  jira: '🎯',
  linear: '📐',
  twitter: '🐦',
  x: '🐦',
  youtube: '▶️',
  trello: '📌',
  airtable: '📊',
  zapier: '⚡',
  stripe: '💳',
  twilio: '📞',
  sendgrid: '📨',
  hubspot: '🧲',
  salesforce: '☁️',
  zendesk: '🎧',
}

// ─── Skill categorisation ─────────────────────────────────────────────────────

function categorizeSkill(name: string): SkillCategory {
  const n = name.toLowerCase()
  if (/bash|python|code|exec|script|run|terminal|compile|node|ruby|rust/.test(n)) return 'code'
  if (/read|write|file|fs|storage|disk|path|dir|folder/.test(n)) return 'file'
  if (/search|web|browse|fetch|http|scrape|crawl|url|internet/.test(n)) return 'web'
  if (/slack|email|telegram|discord|notify|message|send|comm|chat|sms/.test(n)) return 'comm'
  if (/data|db|sql|csv|json|parse|analyz|transform|spread/.test(n)) return 'data'
  return 'other'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface ParsedToolsResult {
  skills: ParsedSkill[]
  resources: ParsedResource[]
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parseToolsMd(content: string): ParsedToolsResult {
  const skills: ParsedSkill[] = []
  const resources: ParsedResource[] = []
  const seen = new Set<string>()

  const add = (rawName: string, description: string | null) => {
    const name = rawName.trim()
    if (!name || name.length < 2 || name.length > 60) return
    const id = slugify(name)
    if (!id || seen.has(id)) return
    seen.add(id)

    const lower = name.toLowerCase()
    if (KNOWN_RESOURCES.has(lower)) {
      resources.push({ id, name, serviceIcon: RESOURCE_ICONS[lower] ?? '🔗' })
    } else {
      skills.push({ id, name, category: categorizeSkill(name), description })
    }
  }

  // Pass 1: ## H2 headers → tool name; first following non-empty line → description
  for (const match of content.matchAll(/^##\s+(.+)$/gm)) {
    const headerName = (match[1] ?? '').trim()
    // Grab the first non-empty line after the header as a description
    const afterHeader = content.slice((match.index ?? 0) + match[0].length)
    const firstLine = afterHeader.split(/\r?\n/).find((l) => l.trim()) ?? null
    add(headerName, firstLine?.trim() || null)
  }

  // Pass 2: bullet list items `- name` or `* name`
  for (const match of content.matchAll(/^[-*]\s+\**([A-Za-z][\w ./_-]{1,50})\**/gm)) {
    add(match[1] ?? '', null)
  }

  // Pass 3: backtick-quoted names `tool_name`
  for (const match of content.matchAll(/`([A-Za-z][\w_-]{1,40})`/g)) {
    add(match[1] ?? '', null)
  }

  return { skills, resources }
}
