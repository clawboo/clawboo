import type { AgentState } from '@/stores/fleet'

/**
 * Resolves the effective leader agent for a team.
 *
 * **Boo Zero is the universal leader.** When a Boo Zero agent exists in the
 * fleet (identified via `useBooZeroStore` / Gateway `defaultId`), it is the
 * leader of every team — regardless of `teamInternalLeadId`. Boo Zero is
 * *teamless* in the DB (`agents.teamId === null`); we don't require it to
 * appear in the team membership before treating it as leader.
 *
 * `teamInternalLeadId` (formerly `leaderAgentId`) is now a secondary concept:
 * the *team-internal lead* that sits between Boo Zero and the rest of the
 * team — only set when the team has a genuine leader role (CTO, Team Lead,
 * etc., detected via `detectGenuineLeader`). When Boo Zero is missing, the
 * team-internal lead becomes the fallback so routing keeps working.
 *
 * Priority:
 *   1. `booZeroAgentId` (when set and the agent exists in `agents`).
 *   2. `teamInternalLeadId` (when set and the agent is a member of `teamId`).
 *   3. First member of the team.
 *   4. `null` — empty team and no Boo Zero.
 */
export function resolveTeamLeader(
  teamId: string,
  teamInternalLeadId: string | null,
  agents: AgentState[],
  booZeroAgentId: string | null,
): string | null {
  // (1) Universal leader: Boo Zero.
  if (booZeroAgentId && agents.some((a) => a.id === booZeroAgentId)) {
    return booZeroAgentId
  }

  // (2) Team-internal lead — only meaningful when it's actually in the team.
  const teamAgents = agents.filter((a) => a.teamId === teamId)
  if (teamAgents.length === 0) return null

  if (teamInternalLeadId && teamAgents.some((a) => a.id === teamInternalLeadId)) {
    return teamInternalLeadId
  }

  // (3) First member fallback.
  return teamAgents[0]?.id ?? null
}

/**
 * Resolves the *team-internal* lead independently of Boo Zero.
 *
 * Used by the Ghost Graph spanning-tree layer and by relay routing when we
 * need to know the team's own designated lead (under Boo Zero). Returns
 * `null` when the team has no internal lead set, or the configured lead is
 * no longer a member of the team.
 *
 * Same signature as the old (pre-Boo-Zero) `resolveTeamLeader`, included
 * here so callers that need the team-internal-only resolution don't have
 * to re-derive it from `agents.filter`.
 */
export function resolveTeamInternalLead(
  teamId: string,
  teamInternalLeadId: string | null,
  agents: AgentState[],
): string | null {
  const teamAgents = agents.filter((a) => a.teamId === teamId)
  if (teamAgents.length === 0) return null
  if (teamInternalLeadId && teamAgents.some((a) => a.id === teamInternalLeadId)) {
    return teamInternalLeadId
  }
  return null
}
