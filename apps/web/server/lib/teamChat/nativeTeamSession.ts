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
// This pointer is written only for the LEADER / user-facing team session. A
// board task run keeps a pointer of its own, per task (see "Per-task pointers"
// below). Cleared on team delete + team-history reset; swept on agent delete.
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
 *  persistent home: a task run (`isTaskRun`) resumes its own per-task pointer
 *  instead (`taskResumeEligible`), and an ephemeral runtime has no session
 *  material to reload. The read (ctx.resume) and the write (setSetting on terminal) share this
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

// ── Per-task pointers ────────────────────────────────────────────────────────
// A board task run continues the agent's own earlier session ON THAT TASK, so a
// retry, a reply or a re-fired run picks up the conversation instead of
// starting cold. Only this resume pointer is per task: the engine's session key
// stays one per (agent, room), because the nudge queue, the session-to-task
// map, the abort map, the steer registry and the chat transcripts all key on it.
//
// A pointer is cleared when its task finishes or is cancelled, and when the task
// is given to someone else, so a reassigned task starts fresh and one task's
// conversation never leaks into another's. OpenClaw has no per-task session:
// its runtime session is the team session itself.

/** The settings-KV key of `agentId`'s resume pointer for `taskId` on `teamId`. */
export function taskSessionSettingKey(agentId: string, teamId: string, taskId: string): string {
  return `${nativeTeamSessionSettingKey(agentId, teamId)}:task:${taskId}`
}

/** SQL LIKE pattern: every agent's pointer for one task (done, cancelled, given
 *  to someone else). Task ids are UUIDs, so the pattern cannot over-match. */
export function taskSessionKeysForTaskLike(taskId: string): string {
  return `native-team-session:%:task:${taskId}`
}

/** SQL LIKE pattern: every task pointer of a team (a team delete). The team and
 *  room patterns above end before `:task:`, so they never reach these. */
export function taskSessionKeysForTeamLike(teamId: string): string {
  return `native-team-session:%:${teamId}:task:%`
}

/** SQL LIKE pattern: every task pointer there is (the boot sweep). */
export const TASK_SESSION_KEYS_LIKE = 'native-team-session:%:task:%'

/** What a task pointer holds. */
export interface TaskSessionPointer {
  /** The runtime's own session id, as its session codec serialized it. */
  sessionId: string
  /** The runtime that holds that session. A pointer another runtime wrote is
   *  never handed to this one. */
  runtime: string
  /** A hash of the task's title and description as that session last saw them,
   *  so a resumed run can be told whether they changed. */
  ticketHash: string
  /** When that session's last run was given its context (epoch ms). Comments
   *  made since are the ones it has not seen. */
  seenAt: number
  /** When that run ended (epoch ms): the agent's own comments up to then are
   *  already in the session, and later ones came from elsewhere. Absent on a
   *  pointer written before it was recorded. */
  endedAt?: number
}

export function encodeTaskSessionPointer(pointer: TaskSessionPointer): string {
  return JSON.stringify(pointer)
}

/** The pointer a setting holds, or null for an empty, cleared or malformed one. */
export function parseTaskSessionPointer(raw: string | null | undefined): TaskSessionPointer | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<TaskSessionPointer>
    if (
      typeof o.sessionId !== 'string' ||
      !o.sessionId ||
      typeof o.runtime !== 'string' ||
      typeof o.ticketHash !== 'string' ||
      typeof o.seenAt !== 'number' ||
      !Number.isFinite(o.seenAt)
    )
      return null
    return {
      sessionId: o.sessionId,
      runtime: o.runtime,
      ticketHash: o.ticketHash,
      seenAt: o.seenAt,
      ...(typeof o.endedAt === 'number' && Number.isFinite(o.endedAt)
        ? { endedAt: o.endedAt }
        : {}),
    }
  } catch {
    return null
  }
}

/** Runtimes whose session lives in the agent's persistent home. */
const TASK_POINTER_HOME_RUNTIMES = new Set(['clawboo-native', 'codex', 'hermes'])

/**
 * May a task run on this team session resume (and record) a per-task pointer?
 *
 *  · Native, Codex and Hermes keep the session in the agent's persistent home
 *    (Native reloads its transcript, Codex resumes its thread, Hermes resumes
 *    its session), so they need that home.
 *  · Claude Code has no home: its session files stay under the operator's
 *    `~/.claude/projects`, keyed by the folder a run starts in, and every team
 *    run starts in the team's own folder.
 *  · OpenClaw never: its runtime session is the team session itself.
 *
 * The read (ctx.resume) and the write (on the run's terminal) share this gate,
 * as the leader pointer's do.
 */
export function taskResumeEligible(args: {
  runtime: string | null
  homeDir: string | null
  isTeamSession: boolean
}): boolean {
  if (!args.isTeamSession || !args.runtime) return false
  if (args.runtime === 'claude-code') return true
  return TASK_POINTER_HOME_RUNTIMES.has(args.runtime) && !!args.homeDir
}
