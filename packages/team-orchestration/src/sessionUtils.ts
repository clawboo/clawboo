// Team-scoped sessionKey helpers. A team-chat run is keyed
// `agent:<agentId>:team:<teamId>` so a team transcript is isolated from 1:1
// agent chat. A team can also have extra chat ROOMS, each a subset of its
// members; a room's runs are keyed `agent:<agentId>:team:<teamId>:room:<roomId>`.
// The team's own group chat is the default room and keeps the plain team key, so
// none of its history moved when rooms arrived. Pure string functions shared by
// the engine's host bindings (browser + server) so the scheme has one definition.

const SESSION_KEY_AGENT_RE = /^agent:([^:]+):/

/** Extracts the agentId from a sessionKey of format `agent:<agentId>:<sessionName>`. */
export function agentIdFromSessionKey(sessionKey: string): string | null {
  const m = sessionKey.match(SESSION_KEY_AGENT_RE)
  return m?.[1] ?? null
}

/** Build a team-scoped sessionKey: `agent:<agentId>:team:<teamId>`, or
 *  `agent:<agentId>:team:<teamId>:room:<roomId>` for a room other than the
 *  team's default one (`roomId` null/absent). */
export function buildTeamSessionKey(
  agentId: string,
  teamId: string,
  roomId?: string | null,
): string {
  const base = `agent:${agentId}:team:${teamId}`
  return roomId ? `${base}:room:${roomId}` : base
}

/**
 * True when `sessionKey` is a team-scoped key (`agent:<agentId>:team:<teamId>`,
 * with or without a `:room:<roomId>` suffix).
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

export interface TeamSessionKeyParts {
  agentId: string
  teamId: string
  /** Null for the team's default room (the plain team key). */
  roomId: string | null
}

const TEAM_KEY_PREFIX_RE = /^agent:([^:]+):team:/
const ROOM_SEP = ':room:'

/**
 * Split a team-scoped sessionKey into its parts, or null if it is not one. Plain
 * string scanning after the anchored prefix, so the cost stays linear whatever a
 * key contains. A room suffix is the LAST `:room:<id>` with a non-empty, colon-
 * free id; anything else after `team:` is the team id (team ids are UUIDs in
 * practice, but a colon in one must not be mistaken for a room).
 */
export function parseTeamSessionKey(sessionKey: string): TeamSessionKeyParts | null {
  const m = sessionKey.match(TEAM_KEY_PREFIX_RE)
  if (!m) return null
  const rest = sessionKey.slice(m[0].length)
  if (rest.length === 0 || /[\r\n\u2028\u2029]/.test(rest)) return null
  const at = rest.lastIndexOf(ROOM_SEP)
  if (at > 0) {
    const roomId = rest.slice(at + ROOM_SEP.length)
    if (roomId.length > 0 && !roomId.includes(':')) {
      return { agentId: m[1]!, teamId: rest.slice(0, at), roomId }
    }
  }
  return { agentId: m[1]!, teamId: rest, roomId: null }
}

/** Extracts the teamId from a team-scoped sessionKey (either shape), or null if
 *  it is not one. */
export function teamIdFromSessionKey(sessionKey: string): string | null {
  return parseTeamSessionKey(sessionKey)?.teamId ?? null
}

/** Extracts the roomId from a room sessionKey, or null for the default room's key
 *  and for anything that is not a team key. */
export function roomIdFromSessionKey(sessionKey: string): string | null {
  return parseTeamSessionKey(sessionKey)?.roomId ?? null
}
