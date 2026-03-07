import { describe, it, expect } from 'vitest'
import { SKILL_CATALOG, getCatalogSkill, searchCatalog } from '../catalog'

const VALID_CATEGORIES = new Set(['code', 'web', 'data', 'comm', 'file', 'other'])
const VALID_SOURCES = new Set(['clawhub', 'skill.sh', 'verified', 'local'])

describe('SKILL_CATALOG', () => {
  it('has 30 skills', () => {
    expect(SKILL_CATALOG).toHaveLength(30)
  })

  it('every skill has required fields', () => {
    for (const skill of SKILL_CATALOG) {
      expect(skill.id).toBeTruthy()
      expect(skill.name).toBeTruthy()
      expect(skill.description).toBeTruthy()
      expect(skill.category).toBeTruthy()
      expect(skill.source).toBeTruthy()
      expect(typeof skill.trustScore).toBe('number')
      expect(skill.version).toBeTruthy()
      expect(skill.author).toBeTruthy()
      expect(Array.isArray(skill.tags)).toBe(true)
      expect(skill.tags.length).toBeGreaterThan(0)
    }
  })

  it('all IDs are unique', () => {
    const ids = SKILL_CATALOG.map((s) => s.id)
    expect(new Set(ids).size).toBe(SKILL_CATALOG.length)
  })

  it('all trustScores are between 0 and 100', () => {
    for (const skill of SKILL_CATALOG) {
      expect(skill.trustScore).toBeGreaterThanOrEqual(0)
      expect(skill.trustScore).toBeLessThanOrEqual(100)
    }
  })

  it('all categories are valid', () => {
    for (const skill of SKILL_CATALOG) {
      expect(VALID_CATEGORIES.has(skill.category)).toBe(true)
    }
  })

  it('all sources are valid', () => {
    for (const skill of SKILL_CATALOG) {
      expect(VALID_SOURCES.has(skill.source)).toBe(true)
    }
  })

  it('has 5 skills per category', () => {
    for (const cat of VALID_CATEGORIES) {
      const count = SKILL_CATALOG.filter((s) => s.category === cat).length
      expect(count).toBe(5)
    }
  })
})

describe('getCatalogSkill', () => {
  it('finds skill by id', () => {
    const skill = getCatalogSkill('bash-executor')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('Bash Executor')
  })

  it('returns undefined for unknown id', () => {
    expect(getCatalogSkill('nonexistent')).toBeUndefined()
  })

  it('can find every catalog skill', () => {
    for (const skill of SKILL_CATALOG) {
      expect(getCatalogSkill(skill.id)).toBe(skill)
    }
  })
})

describe('searchCatalog', () => {
  it('empty query returns all skills', () => {
    expect(searchCatalog('')).toHaveLength(30)
    expect(searchCatalog('  ')).toHaveLength(30)
  })

  it('matches by name', () => {
    const results = searchCatalog('bash')
    expect(results.some((s) => s.id === 'bash-executor')).toBe(true)
  })

  it('matches by description', () => {
    const results = searchCatalog('PDF')
    expect(results.some((s) => s.id === 'pdf-reader')).toBe(true)
  })

  it('matches by tags', () => {
    const results = searchCatalog('jest')
    expect(results.some((s) => s.id === 'test-runner')).toBe(true)
  })

  it('is case insensitive', () => {
    const lower = searchCatalog('bash')
    const upper = searchCatalog('BASH')
    expect(lower).toEqual(upper)
  })

  it('returns empty for no match', () => {
    expect(searchCatalog('zzzznonexistent')).toHaveLength(0)
  })

  it('matches partial name', () => {
    const results = searchCatalog('exec')
    expect(results.some((s) => s.id === 'bash-executor')).toBe(true)
    expect(results.some((s) => s.id === 'python-executor')).toBe(true)
  })
})
