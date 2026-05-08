import { describe, it, expect } from 'vitest'
import { AGENT_CATALOG } from '../agents'
import { TEAM_CATALOG, resolveTeamAgents, getAgent } from '../teamCatalog'

describe('Team coverage invariants', () => {
  it('every team agentId resolves to a valid catalog entry', () => {
    for (const team of TEAM_CATALOG) {
      if (!team.agentIds) continue
      for (const id of team.agentIds) {
        expect(getAgent(id), `team ${team.id} references missing agent ${id}`).toBeDefined()
      }
    }
  })

  it('no team resolves to zero agents', () => {
    for (const team of TEAM_CATALOG) {
      const resolved = resolveTeamAgents(team)
      expect(resolved.length, `team ${team.id} has zero agents`).toBeGreaterThan(0)
    }
  })

  it('all team IDs unique', () => {
    const ids = TEAM_CATALOG.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has synthetic teams covering agency agents', () => {
    const synthetic = TEAM_CATALOG.filter((t) => t.isSynthetic === true)
    expect(synthetic.length, 'expected synthetic excellence teams').toBeGreaterThanOrEqual(20)
  })

  it('every catalog agent appears in at least one team', () => {
    const covered = new Set<string>()
    for (const team of TEAM_CATALOG) {
      if (team.agentIds) {
        for (const id of team.agentIds) covered.add(id)
      }
    }
    const uncovered = AGENT_CATALOG.filter((a) => !covered.has(a.id)).map((a) => a.id)
    // Surface up to 10 uncovered IDs in the failure message for easy diagnosis.
    if (uncovered.length > 0) {
      throw new Error(
        `Expected every agent to appear in at least one team, but ${uncovered.length} are uncovered. ` +
          `First 10: ${uncovered.slice(0, 10).join(', ')}`,
      )
    }
    expect(uncovered).toEqual([])
  })
})
