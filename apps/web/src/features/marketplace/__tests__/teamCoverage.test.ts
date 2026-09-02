import { describe, it, expect } from 'vitest'

import { SOURCE_TEAMS, sourceAgent, sourceTeamBody } from '@/__vitest__/packSource'

describe('Team coverage invariants', () => {
  it('every team member resolves to a valid catalog entry', () => {
    for (const team of SOURCE_TEAMS) {
      for (const member of team.members) {
        expect(
          sourceAgent(member.agentId),
          `team ${team.id} references missing agent ${member.agentId}`,
        ).toBeDefined()
      }
    }
  })

  // Was `resolveTeamAgents(team).length > 0`, which now needs the network. The
  // invariant it actually guards is a pure property of the source: a team must
  // name at least one member. Dangling ids are covered by the test above.
  it('no team has an empty roster', () => {
    for (const team of SOURCE_TEAMS) {
      expect(team.members.length, `team ${team.id} has zero agents`).toBeGreaterThan(0)
    }
  })

  it('all team IDs unique', () => {
    const ids = SOURCE_TEAMS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // Routing keyed by an id that is not on the roster silently never fires, and a
  // member with no routing deploys with no team instructions at all. The same
  // rule is a shipping gate in `scripts/catalog/validate.ts`, which is what a
  // content-only PR runs instead of this suite.
  it('routing names every member of its own team, and nobody else', () => {
    const problems: string[] = []
    for (const team of SOURCE_TEAMS) {
      const routing = sourceTeamBody(team.id)?.routing ?? {}
      const members = new Set(team.members.map((m) => m.agentId))
      for (const key of Object.keys(routing)) {
        if (!members.has(key)) problems.push(`${team.id} routes to non-member ${key}`)
      }
      for (const member of members) {
        if (routing[member] === undefined) problems.push(`${team.id} has no routing for ${member}`)
      }
    }
    expect(problems).toEqual([])
  })

  // DELETED with the synthetic teams: 'has synthetic teams covering agency agents'
  // and 'every catalog agent appears in at least one team'.
  //
  // The coverage invariant was backwards. It made catalog growth MANUFACTURE team
  // padding: 164 of 179 agency agents were covered only by 30 generated
  // hub-and-spoke teams that existed for no reason except to satisfy it. Deleting
  // the padding without deleting the rule that demanded it would just fail the
  // suite for a reason that looks like a schema regression. Browse-by-agent is the
  // real answer to discoverability, and curation moved to human review of content
  // PRs (decision 7: no auto-merge).
})
