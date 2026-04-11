import { describe, it, expect } from 'vitest'
import { AGENT_CATALOG } from '../agents'
import { getCatalogSkill } from '../catalog'

describe('AGENT_CATALOG', () => {
  it('has at least 160 entries', () => {
    expect(AGENT_CATALOG.length).toBeGreaterThanOrEqual(160)
  })

  it('all IDs are unique', () => {
    const ids = AGENT_CATALOG.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all entries have non-empty soulTemplate', () => {
    for (const e of AGENT_CATALOG) {
      expect(e.soulTemplate.trim().length, `${e.id} soulTemplate is empty`).toBeGreaterThan(0)
    }
  })

  it('all entries have non-empty toolsTemplate', () => {
    for (const e of AGENT_CATALOG) {
      expect(e.toolsTemplate.trim().length, `${e.id} toolsTemplate is empty`).toBeGreaterThan(0)
    }
  })

  it('identityTemplate.length > 500 (full content preserved — not condensed)', () => {
    for (const e of AGENT_CATALOG) {
      expect(
        e.identityTemplate.length,
        `${e.id} identityTemplate too short (${e.identityTemplate.length} chars) — content may have been condensed`,
      ).toBeGreaterThan(500)
    }
  })

  it('skillIds reference valid SKILL_CATALOG entries', () => {
    for (const e of AGENT_CATALOG) {
      for (const id of e.skillIds) {
        expect(getCatalogSkill(id), `${e.id} references unknown skillId "${id}"`).toBeDefined()
      }
    }
  })

  it('all entries have valid domain, source, category', () => {
    const validSources = ['agency-agents', 'awesome-openclaw', 'clawboo'] as const
    for (const e of AGENT_CATALOG) {
      expect(e.domain, `${e.id} missing domain`).toBeTruthy()
      expect(validSources, `${e.id} has invalid source "${e.source}"`).toContain(e.source)
      expect(e.category, `${e.id} missing category`).toBeTruthy()
    }
  })

  it('all entries have sourceUrl starting with the agency-agents GitHub URL', () => {
    for (const e of AGENT_CATALOG) {
      expect(e.sourceUrl, `${e.id} sourceUrl should point to agency-agents`).toMatch(
        /^https:\/\/github\.com\/msitarzewski\/agency-agents\/blob\//,
      )
    }
  })
})
