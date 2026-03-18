import { describe, it, expect } from 'vitest'
import type { TemplateCategory, TemplateSource } from '@/features/teams/types'
import {
  TEAM_CATALOG,
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
  it('is an array', () => {
    expect(Array.isArray(TEAM_CATALOG)).toBe(true)
  })
})

describe('searchTeamCatalog', () => {
  it('returns empty for no matches', () => {
    expect(searchTeamCatalog('zzz-nonexistent-query-xyz')).toEqual([])
  })

  it('returns full catalog for empty query', () => {
    expect(searchTeamCatalog('')).toBe(TEAM_CATALOG)
  })
})

describe('getTeamTemplate', () => {
  it('returns undefined for unknown ID', () => {
    expect(getTeamTemplate('nonexistent-id')).toBeUndefined()
  })
})

describe('getTemplatesByCategory', () => {
  it('returns empty for unused category', () => {
    expect(getTemplatesByCategory('spatial')).toEqual([])
  })
})

describe('getTemplatesBySource', () => {
  it('returns empty for unused source', () => {
    expect(getTemplatesBySource('awesome-openclaw')).toEqual([])
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
