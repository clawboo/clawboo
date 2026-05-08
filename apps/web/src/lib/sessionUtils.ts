const SESSION_KEY_AGENT_RE = /^agent:([^:]+):/

/** Extracts the agentId from a sessionKey of format `agent:<agentId>:<sessionName>`. */
export function agentIdFromSessionKey(sessionKey: string): string | null {
  const m = SESSION_KEY_AGENT_RE.exec(sessionKey)
  return m?.[1] ?? null
}

/** Build a team-scoped sessionKey: `agent:<agentId>:team:<teamId>`. */
export function buildTeamSessionKey(agentId: string, teamId: string): string {
  return `agent:${agentId}:team:${teamId}`
}

// ─── Team chat override ──────────────────────────────────────────────────────
// The Gateway echoes events with the agent's main sessionKey regardless of
// which custom sessionKey was used in chat.send. This redirect map ensures
// incoming events for agents currently processing team chat messages are
// stored under the team sessionKey, not the main one.

const teamChatOverrides = new Map<string, string>()

/** Mark an agent as currently processing a team chat message. */
export function setTeamChatOverride(agentId: string, teamSessionKey: string): void {
  teamChatOverrides.set(agentId, teamSessionKey)
}

/** Clear the team redirect after the agent finishes responding. */
export function clearTeamChatOverride(agentId: string): void {
  teamChatOverrides.delete(agentId)
}

/** Get the team sessionKey redirect for an agent, if active. */
export function getTeamChatOverride(agentId: string): string | undefined {
  return teamChatOverrides.get(agentId)
}

/** Check if an agent currently has an active team chat override (is processing a team message). */
export function hasTeamChatOverride(agentId: string): boolean {
  return teamChatOverrides.has(agentId)
}

/** Clear all overrides — exposed for testing. */
export function resetTeamChatOverrides(): void {
  teamChatOverrides.clear()
}
