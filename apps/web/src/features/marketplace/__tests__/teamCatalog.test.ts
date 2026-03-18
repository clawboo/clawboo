import { describe, it, expect } from 'vitest'
import type { TemplateCategory, TemplateSource } from '@/features/teams/types'
import {
  TEAM_CATALOG,
  STARTER_TEMPLATES,
  searchTeamCatalog,
  getTeamTemplate,
  getTemplatesByCategory,
  getTemplatesBySource,
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
  it('has 62 templates (5 builtin + 57 agency)', () => {
    expect(TEAM_CATALOG.length).toBe(62)
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

  it('every agent has non-empty soulTemplate, identityTemplate, toolsTemplate', () => {
    for (const t of TEAM_CATALOG) {
      for (const agent of t.agents) {
        expect(agent.soulTemplate.length).toBeGreaterThan(0)
        expect(agent.identityTemplate.length).toBeGreaterThan(0)
        expect(agent.toolsTemplate.length).toBeGreaterThan(0)
      }
    }
  })

  it('AGENTS.md @mentions reference valid agent names within the same template', () => {
    const mentionRegex = /@([\w][\w ._-]{0,60})/g
    for (const t of TEAM_CATALOG) {
      const agentNames = t.agents.map((a) => a.name)
      for (const agent of t.agents) {
        if (!agent.agentsTemplate) continue
        const mentions: string[] = []
        let match: RegExpExecArray | null
        while ((match = mentionRegex.exec(agent.agentsTemplate)) !== null) {
          mentions.push(match[1])
        }
        for (const mention of mentions) {
          expect(agentNames.some((name) => mention.startsWith(name))).toBe(true)
        }
      }
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
  it('returns empty for unused category', () => {
    expect(getTemplatesByCategory('devops')).toEqual([])
  })

  it('finds templates by category', () => {
    expect(getTemplatesByCategory('marketing').length).toBeGreaterThan(0)
  })
})

describe('getTemplatesBySource', () => {
  it('returns empty for unused source', () => {
    expect(getTemplatesBySource('awesome-openclaw')).toEqual([])
  })

  it('finds builtin templates', () => {
    expect(getTemplatesBySource('clawboo').length).toBe(5)
  })

  it('finds agency-agents templates', () => {
    expect(getTemplatesBySource('agency-agents').length).toBe(57)
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
