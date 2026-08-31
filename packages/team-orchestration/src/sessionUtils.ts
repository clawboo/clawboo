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
 * A team run's transcript is persisted under the team key by the orchestrator, so
 * this marks the turns that belong to a room rather than to one person's chat.
 * Distinct from the 1:1 key (`agent:<id>:native`), a board task
 * (`runtime:...:task:...`), and peer chat (`teamchat:...`).
 */
const TEAM_SESSION_KEY_RE = /^agent:[^:]+:team:/

export function isTeamSessionKey(sessionKey: string): boolean {
  return TEAM_SESSION_KEY_RE.test(sessionKey)
}

/**
 * The 1:1 chat key for an agent: the conversation a person has with one boo.
 *
 * One agent runs in several places at once, each with its own key, and only this
 * one is a chat someone is looking at. Anything that writes into a person's chat
 * has to recognise THIS key rather than rule out the other shapes it knows of: a
 * boo working three board tasks in parallel would otherwise drop three replies
 * into the chat, unprompted, with no question in front of them.
 */
export function nativeChatSessionKey(agentId: string): string {
  return `agent:${agentId}:native`
}

/** Extracts the teamId from a team-scoped sessionKey, or null if it is not one. */
export function teamIdFromSessionKey(sessionKey: string): string | null {
  const m = sessionKey.match(/^agent:[^:]+:team:(.+)$/)
  return m?.[1] ?? null
}
