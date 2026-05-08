import { describe, it, expect } from 'vitest'
import { AGENT_CATALOG } from '../agents'
import { getCatalogSkill } from '../catalog'

describe('AGENT_CATALOG', () => {
  it('has at least 270 entries total (agency + awesome-openclaw + clawboo)', () => {
    expect(AGENT_CATALOG.length).toBeGreaterThanOrEqual(270)
  })

  it('has at least 160 agency-agents entries', () => {
    const agency = AGENT_CATALOG.filter((a) => a.source === 'agency-agents')
    expect(agency.length).toBeGreaterThanOrEqual(160)
  })

  it('has at least 40 awesome-openclaw entries', () => {
    const awesome = AGENT_CATALOG.filter((a) => a.source === 'awesome-openclaw')
    expect(awesome.length).toBeGreaterThanOrEqual(40)
  })

  it('has at least 15 clawboo entries', () => {
    const clawboo = AGENT_CATALOG.filter((a) => a.source === 'clawboo')
    expect(clawboo.length).toBeGreaterThanOrEqual(15)
  })

  it('all IDs are globally unique across sources', () => {
    const ids = AGENT_CATALOG.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('id prefixes match source', () => {
    for (const e of AGENT_CATALOG) {
      if (e.source === 'agency-agents') {
        expect(e.id, `${e.id} should start with 'agency-'`).toMatch(/^agency-/)
      } else if (e.source === 'awesome-openclaw') {
        expect(e.id, `${e.id} should start with 'awesome-'`).toMatch(/^awesome-/)
      } else if (e.source === 'clawboo') {
        expect(e.id, `${e.id} should start with 'clawboo-'`).toMatch(/^clawboo-/)
      }
    }
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

  it('identityTemplate.length > 500 (zero-loss — full content preserved)', () => {
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

  it('sourceUrl matches the entry source', () => {
    for (const e of AGENT_CATALOG) {
      if (e.source === 'agency-agents') {
        expect(e.sourceUrl, `${e.id} should reference the agency-agents repo`).toMatch(
          /^https:\/\/github\.com\/msitarzewski\/agency-agents\/blob\//,
        )
      } else if (e.source === 'awesome-openclaw') {
        expect(e.sourceUrl, `${e.id} should reference the awesome-openclaw-usecases repo`).toMatch(
          /^https:\/\/github\.com\/hesamsheikh\/awesome-openclaw-usecases\/blob\//,
        )
      } else if (e.source === 'clawboo') {
        // clawboo builtin agents are local — sourceUrl is an empty string
        expect(typeof e.sourceUrl, `${e.id} sourceUrl must be a string`).toBe('string')
      }
    }
  })

  it('getAgent() returns the same entry by id (no === string regression)', async () => {
    const { getAgent } = await import('../agents')
    const sample = AGENT_CATALOG[0]
    expect(sample).toBeDefined()
    if (sample) {
      expect(getAgent(sample.id)?.id).toBe(sample.id)
    }
  })
})
