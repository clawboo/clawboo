import type { AgentState } from '@/stores/fleet'

/**
 * Resolves the effective leader agent for a team.
 * Priority: (1) explicit leaderAgentId if agent exists in team,
 *           (2) first agent in the team, (3) null
 */
export function resolveTeamLeader(
  teamId: string,
  leaderAgentId: string | null,
  agents: AgentState[],
): string | null {
  const teamAgents = agents.filter((a) => a.teamId === teamId)
  if (teamAgents.length === 0) return null
  if (leaderAgentId && teamAgents.some((a) => a.id === leaderAgentId)) return leaderAgentId
  return teamAgents[0]?.id ?? null
}
