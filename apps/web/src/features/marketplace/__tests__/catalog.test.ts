import { describe, it, expect } from 'vitest'
import {
  BUILTIN_SKILLS,
  buildSkillRegistry,
  builtinSkillCollisions,
  assertNoBuiltinSkillCollision,
  getCatalogSkill,
  searchCatalog,
  type CatalogSkill,
} from '../catalog'

const VALID_CATEGORIES = new Set(['code', 'web', 'data', 'comm', 'file', 'other'])

// FLOORS, NOT EXACT COUNTS. The builtin set grew from 30 tool-shaped skills to
// 44 when the 14 process-shaped playbooks landed, and it will grow again. An
// exact count asserts nothing about quality: it only guarantees that every
// addition arrives with a test edit attached, which trains people to update the
// number rather than read the rule. The floors keep the real invariant, that the
// set never silently shrinks.
describe('BUILTIN_SKILLS', () => {
  it('ships at least 30 skills', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(30)
  })

  it('every skill has required fields', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.id).toBeTruthy()
      expect(skill.name).toBeTruthy()
      expect(skill.description).toBeTruthy()
      expect(skill.category).toBeTruthy()
      expect(Array.isArray(skill.tags)).toBe(true)
      expect(skill.tags.length).toBeGreaterThan(0)
    }
  })

  it('all IDs are unique', () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(BUILTIN_SKILLS.length)
  })

  it('all categories are valid', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(VALID_CATEGORIES.has(skill.category)).toBe(true)
    }
  })

  it('has at least 5 skills in every category', () => {
    for (const cat of VALID_CATEGORIES) {
      const count = BUILTIN_SKILLS.filter((s) => s.category === cat).length
      expect(count, `category "${cat}" has ${count} skill(s)`).toBeGreaterThanOrEqual(5)
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
    for (const skill of BUILTIN_SKILLS) {
      expect(getCatalogSkill(skill.id)).toBe(skill)
    }
  })
})

describe('searchCatalog', () => {
  it('empty query returns all skills', () => {
    expect(searchCatalog('')).toHaveLength(BUILTIN_SKILLS.length)
    expect(searchCatalog('  ')).toHaveLength(BUILTIN_SKILLS.length)
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

// ─── The merged registry ────────────────────────────────────────────────────

const packSkill = (over: Partial<CatalogSkill> = {}): CatalogSkill => ({
  id: 'agency-story-mapper',
  name: 'Story Mapper',
  description: 'Turns a brief into a mapped set of user stories.',
  category: 'data',
  tags: ['stories'],
  ...over,
})

describe('buildSkillRegistry', () => {
  it('includes every builtin', () => {
    const merged = buildSkillRegistry([])
    expect(merged.size).toBe(BUILTIN_SKILLS.length)
    for (const s of BUILTIN_SKILLS) expect(merged.get(s.id)).toBe(s)
  })

  it('adds pack skills alongside the builtins', () => {
    const merged = buildSkillRegistry([packSkill()])
    expect(merged.size).toBe(BUILTIN_SKILLS.length + 1)
    expect(merged.get('agency-story-mapper')?.name).toBe('Story Mapper')
  })

  it('lets the BUILTIN win a collision, whatever the pack says', () => {
    const impostor = packSkill({ id: 'bash-executor', name: 'Not The Real One' })
    const merged = buildSkillRegistry([impostor])
    expect(merged.get('bash-executor')).toBe(BUILTIN_SKILLS.find((s) => s.id === 'bash-executor'))
    expect(merged.get('bash-executor')?.name).toBe('Bash Executor')
  })

  it('lets the FIRST pack win a pack-vs-pack collision, so the merge is order-stable', () => {
    const first = packSkill({ name: 'First' })
    const second = packSkill({ name: 'Second' })
    expect(buildSkillRegistry([first, second]).get('agency-story-mapper')?.name).toBe('First')
  })

  it("coerces an unrecognised category to 'other' rather than dropping the skill", () => {
    const odd = packSkill({ category: 'quantum' as CatalogSkill['category'] })
    const merged = buildSkillRegistry([odd])
    expect(merged.get('agency-story-mapper')?.category).toBe('other')
  })
})

describe('builtin skill collisions', () => {
  it('reports nothing for a clean pack', () => {
    expect(builtinSkillCollisions([packSkill()])).toEqual([])
    expect(() => assertNoBuiltinSkillCollision([packSkill()])).not.toThrow()
  })

  // Builtin-wins alone is not enough: POST /api/skills validates field types, not
  // membership, so a divergent row for a colliding id can still be written by
  // direct POST. Catching it at pack-build time puts it in front of a reviewer.
  it('reports a builtin id, once, and the assert throws naming it', () => {
    const colliding = [packSkill({ id: 'linter' }), packSkill({ id: 'linter' })]
    expect(builtinSkillCollisions(colliding)).toEqual(['linter'])
    expect(() => assertNoBuiltinSkillCollision(colliding)).toThrow(/linter/)
  })
})
