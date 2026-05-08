import { describe, it, expect } from 'vitest'
import type { TemplateCategory, TemplateSource } from '@/features/teams/types'
import {
  TEAM_CATALOG,
  STARTER_TEMPLATES,
  searchTeamCatalog,
  getTeamTemplate,
  getTemplatesByCategory,
  getTemplatesBySource,
  resolveTeamAgents,
  TEMPLATE_CATEGORIES,
  SOURCE_META,
} from '../teamCatalog'

const ALL_CATEGORIES: TemplateCategory[] = [
  'engineering',
  'marketing',
  'sales',
  'product',
  'design',
  'testing',
  'content',
  'support',
  'education',
  'ops',
  'devops',
  'research',
  'game-dev',
  'spatial',
  'academic',
  'paid-media',
  'specialized',
  'general',
]

const ALL_SOURCES: TemplateSource[] = ['clawboo', 'agency-agents', 'awesome-openclaw']

describe('TEAM_CATALOG', () => {
  it('has at least 70 templates across all sources', () => {
    expect(TEAM_CATALOG.length).toBeGreaterThanOrEqual(70)
  })

  it('all IDs are unique', () => {
    const ids = TEAM_CATALOG.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('each template has valid category and source', () => {
    for (const t of TEAM_CATALOG) {
      expect(ALL_CATEGORIES).toContain(t.category)
      expect(ALL_SOURCES).toContain(t.source)
    }
  })

  it('every resolved agent has non-empty soulTemplate, identityTemplate, toolsTemplate', () => {
    for (const t of TEAM_CATALOG) {
      const resolved = resolveTeamAgents(t)
      expect(resolved.length).toBeGreaterThan(0)
      for (const agent of resolved) {
        expect(agent.soulTemplate.length).toBeGreaterThan(0)
        expect(agent.identityTemplate.length).toBeGreaterThan(0)
        expect(agent.toolsTemplate.length).toBeGreaterThan(0)
      }
    }
  })

  it('AGENTS.md @mentions reference valid agent names within the same template', () => {
    const mentionRegex = /@([\w][\w ._-]{0,60})/g
    for (const t of TEAM_CATALOG) {
      const resolved = resolveTeamAgents(t)
      const agentNames = resolved.map((a) => a.name)
      for (const agent of resolved) {
        if (!agent.agentsTemplate) continue
        const mentions: string[] = []
        let match: RegExpExecArray | null
        while ((match = mentionRegex.exec(agent.agentsTemplate)) !== null) {
          mentions.push(match[1])
        }
        for (const mention of mentions) {
          const trimmed = mention.trim()
          expect(
            agentNames.some((name) => name.startsWith(trimmed) || trimmed.startsWith(name)),
          ).toBe(true)
        }
      }
    }
  })

  it('has no duplicate team names', () => {
    const names = TEAM_CATALOG.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every template has description, tags, emoji, and color', () => {
    for (const t of TEAM_CATALOG) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.tags.length).toBeGreaterThan(0)
      expect(t.emoji.length).toBeGreaterThan(0)
      expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})

describe('STARTER_TEMPLATES', () => {
  it('equals TEAM_CATALOG filtered by source clawboo', () => {
    const expected = TEAM_CATALOG.filter((t) => t.source === 'clawboo')
    expect(STARTER_TEMPLATES).toEqual(expected)
  })
})

describe('searchTeamCatalog', () => {
  it('returns empty for no matches', () => {
    expect(searchTeamCatalog('zzz-nonexistent-query-xyz')).toEqual([])
  })

  it('returns full catalog for empty query', () => {
    expect(searchTeamCatalog('')).toBe(TEAM_CATALOG)
  })

  it('finds templates by tag', () => {
    const results = searchTeamCatalog('seo')
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns results for common search terms', () => {
    for (const term of ['marketing', 'dev', 'ai', 'web']) {
      const results = searchTeamCatalog(term)
      expect(results.length).toBeGreaterThan(0)
    }
  })
})

describe('getTeamTemplate', () => {
  it('returns undefined for unknown ID', () => {
    expect(getTeamTemplate('nonexistent-id')).toBeUndefined()
  })

  it('finds template by ID', () => {
    const t = getTeamTemplate('marketing')
    expect(t).toBeDefined()
    expect(t!.name).toBe('Marketing Squad')
  })
})

describe('getTemplatesByCategory', () => {
  it('finds devops templates', () => {
    expect(getTemplatesByCategory('devops').length).toBeGreaterThanOrEqual(1)
  })

  it('finds templates by category', () => {
    expect(getTemplatesByCategory('marketing').length).toBeGreaterThan(0)
  })
})

describe('getTemplatesBySource', () => {
  it('finds awesome-openclaw templates', () => {
    expect(getTemplatesBySource('awesome-openclaw').length).toBeGreaterThanOrEqual(40)
  })

  it('finds builtin templates', () => {
    expect(getTemplatesBySource('clawboo').length).toBe(5)
  })

  it('finds agency-agents templates', () => {
    expect(getTemplatesBySource('agency-agents').length).toBeGreaterThanOrEqual(30)
  })
})

describe('TEMPLATE_CATEGORIES', () => {
  it('has an entry for every TemplateCategory value', () => {
    const keys = TEMPLATE_CATEGORIES.map((c) => c.key)
    for (const cat of ALL_CATEGORIES) {
      expect(keys).toContain(cat)
    }
  })

  it('each entry has label and color', () => {
    for (const entry of TEMPLATE_CATEGORIES) {
      expect(entry.label).toBeTruthy()
      expect(entry.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})

describe('SOURCE_META', () => {
  it('has an entry for every TemplateSource value', () => {
    for (const source of ALL_SOURCES) {
      expect(SOURCE_META[source]).toBeDefined()
    }
  })

  it('each entry has label and color', () => {
    for (const source of ALL_SOURCES) {
      const meta = SOURCE_META[source]
      expect(meta.label).toBeTruthy()
      expect(meta.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})
