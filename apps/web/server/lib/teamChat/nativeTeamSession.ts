// Native team-chat session pointers — the resumable-handle bookkeeping that gives
// a native team LEADER (Boo Zero) conversational continuity across turns, the way
// `native-chat-session:<agentId>` gives a 1:1 native chat continuity (driveAgentChat).
//
// Keyed per-(agentId, teamId) — NOT per-agent — on purpose: Boo Zero is one teamless
// native identity that leads EVERY team out of a SINGLE shared per-identity home dir
// (identityHome keys the home on (runtime, agent) only, not team). A per-agent key
// like the 1:1 `native-chat-session:<agentId>` would cross-contaminate team A's,
// team B's, and the personal 1:1 chat transcripts. The team + team-scoped session
// key `agent:<id>:team:<teamId>` is the correct granularity.
//
// A pointer is written only for the LEADER / user-facing team session (never a
// delegated CHILD task run — its continuity is the executor's AGENT_HANDOFF path).
// Cleared on team delete + team-history reset; swept on agent delete.
//
// A team's extra chat ROOMS are separate conversations, so each gets its own
// pointer, suffixed `:room:<roomId>` (Boo Zero leading the default room and a
// room must not resume one conversation into the other). The default room keeps
// the original key, so existing pointers stay valid.

/** The settings-KV key holding the LATEST native harness session id for `agentId`'s
 *  leader/user-facing turns on `teamId` (and room, when not the default room). */
export function nativeTeamSessionSettingKey(
  agentId: string,
  teamId: string,
  roomId?: string | null,
): string {
  const base = `native-team-session:${agentId}:${teamId}`
  return roomId ? `${base}:room:${roomId}` : base
}

/** SQL LIKE pattern matching every team-session pointer for a team (all members) —
 *  used to sweep the pointers when a team is deleted. Agent ids + team ids are
 *  colon-free (native ids are `native-<slug>-<6char>`; team ids are UUIDs), so the
 *  middle `%` can't over-match across the delimiter. */
export function nativeTeamSessionKeysForTeamLike(teamId: string): string {
  return `native-team-session:%:${teamId}`
}

/** SQL LIKE pattern matching every ROOM pointer for a team (all rooms, all
 *  members). The team pattern above ends at the team id, so it never reaches a
 *  room pointer; a team delete sweeps both. */
export function nativeTeamSessionRoomKeysForTeamLike(teamId: string): string {
  return `native-team-session:%:${teamId}:room:%`
}

/** SQL LIKE pattern matching every member's pointer for ONE room (archiving it). */
export function nativeTeamSessionKeysForRoomLike(teamId: string, roomId: string): string {
  return `native-team-session:%:${teamId}:room:${roomId}`
}

/** SQL LIKE pattern matching every team-session pointer for an agent (all teams and
 *  rooms), used to sweep the pointers when an agent is deleted. */
export function nativeTeamSessionKeysForAgentLike(agentId: string): string {
  return `native-team-session:${agentId}:%`
}

/** The runtimes that use the team-leader session-pointer scheme. Native reloads its
 *  persisted transcript from the per-identity home; CODEX resumes its native thread
 *  (`codex exec resume <id>` against the managed home's sessions/ dir — the ChatGPT-
 *  subscription leader's continuity). Both need a PERSISTENT home for the session
 *  material to survive between turns. */
const POINTER_RUNTIMES = new Set(['clawboo-native', 'codex'])

/** Whether a team run should resume (and persist) a leader session pointer.
 *  TRUE only for a pointer-scheme runtime's LEADER / user-facing team session with a
 *  persistent home: a delegated CHILD task (`isTaskRun`) keeps its own
 *  executor-handoff continuity, and an ephemeral runtime has no session material to
 *  reload. The read (ctx.resume) and the write (setSetting on terminal) share this
 *  one gate so they can never diverge. (The settings key keeps its historical
 *  `native-team-session:` prefix — the sweeps on team delete / agent archive key off
 *  it, and it is per-(agent, team) so a codex agent's pointer can never collide with
 *  a native one.) */
export function teamResumeEligible(args: {
  runtime: string | null
  homeDir: string | null
  isTeamSession: boolean
  isTaskRun: boolean
}): boolean {
  return (
    !!args.runtime &&
    POINTER_RUNTIMES.has(args.runtime) &&
    !!args.homeDir &&
    args.isTeamSession &&
    !args.isTaskRun
  )
}
