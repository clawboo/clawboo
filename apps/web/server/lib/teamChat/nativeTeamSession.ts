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

/** The settings-KV key holding the LATEST native harness session id for `agentId`'s
 *  leader/user-facing turns on `teamId`. */
export function nativeTeamSessionSettingKey(agentId: string, teamId: string): string {
  return `native-team-session:${agentId}:${teamId}`
}

/** SQL LIKE pattern matching every team-session pointer for a team (all members) —
 *  used to sweep the pointers when a team is deleted. Agent ids + team ids are
 *  colon-free (native ids are `native-<slug>-<6char>`; team ids are UUIDs), so the
 *  middle `%` can't over-match across the delimiter. */
export function nativeTeamSessionKeysForTeamLike(teamId: string): string {
  return `native-team-session:%:${teamId}`
}

/** SQL LIKE pattern matching every team-session pointer for an agent (all teams) —
 *  used to sweep the pointers when an agent is deleted. */
export function nativeTeamSessionKeysForAgentLike(agentId: string): string {
  return `native-team-session:${agentId}:%`
}

/** Whether a team run should resume (and persist) a native leader session pointer.
 *  TRUE only for the native LEADER / user-facing team session with a persistent home:
 *  a delegated CHILD task (`isTaskRun`) keeps its own executor-handoff continuity, an
 *  ephemeral runtime has no transcript to reload, and only the native runtime uses this
 *  pointer scheme. The read (ctx.resume) and the write (setSetting on terminal) share
 *  this one gate so they can never diverge. */
export function teamResumeEligible(args: {
  runtime: string | null
  homeDir: string | null
  isTeamSession: boolean
  isTaskRun: boolean
}): boolean {
  return (
    args.runtime === 'clawboo-native' && !!args.homeDir && args.isTeamSession && !args.isTaskRun
  )
}
