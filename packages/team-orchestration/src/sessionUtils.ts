// Team-scoped sessionKey helpers. A team-chat run is keyed
// `agent:<agentId>:team:<teamId>` so a team transcript is isolated from 1:1
// agent chat. Pure string functions shared by the engine's host bindings
// (browser + server) so the sessionKey scheme has one definition.

const SESSION_KEY_AGENT_RE = /^agent:([^:]+):/

/** Extracts the agentId from a sessionKey of format `agent:<agentId>:<sessionName>`. */
export function agentIdFromSessionKey(sessionKey: string): string | null {
  const m = sessionKey.match(SESSION_KEY_AGENT_RE)
  return m?.[1] ?? null
}

/** Build a team-scoped sessionKey: `agent:<agentId>:team:<teamId>`. */
export function buildTeamSessionKey(agentId: string, teamId: string): string {
  return `agent:${agentId}:team:${teamId}`
}

/**
 * True when `sessionKey` is a team-scoped key (`agent:<agentId>:team:<teamId>`).
 * The de-double signal: a runtime adapter run on a team key is persisted under the
 * team transcript by the orchestrator, so the runtime's own per-agent chat write
 * (e.g. the native driver's `agent:<id>:native`) must be skipped to keep the team
 * turn out of the agent's 1:1 history. Distinguishes the team key from the 1:1
 * (`agent:<id>:native`), board-task (`runtime:...:task:...`), and peer-chat
 * (`teamchat:...`) key shapes.
 */
const TEAM_SESSION_KEY_RE = /^agent:[^:]+:team:/

export function isTeamSessionKey(sessionKey: string): boolean {
  return TEAM_SESSION_KEY_RE.test(sessionKey)
}
