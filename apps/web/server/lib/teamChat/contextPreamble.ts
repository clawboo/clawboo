// The server-side team-context preamble — the volatile-tier block prepended to
// EVERY server-orchestrated team run (the user's turn to the leader AND every
// delegated child turn, since both flow through `serverDeliver.deliver`). It carries
// three things the agent needs to act correctly, in order:
//   1. the team's durable RULES (set by the user via `/rule` or the team settings),
//   2. the user's onboarding SELF-INTRODUCTION ([About the User]),
//   3. the live team ROSTER (teammates by NAME, recipient excluded — so the leader
//      can `delegate` to a teammate by name, robust to renames).
//
// It rides `opts.context` (the volatile first-message tier), NOT the stable system
// prompt, so it never busts the provider prefix cache. Reads are cheap indexed
// SQLite point-reads, rebuilt per turn — no cache needed. Empty blocks are dropped,
// so with no rules + no intro this returns exactly the bare roster line (and null
// when there are no other teammates either).
//
// The rules / about-user framing strings match the browser's `buildTeamRulesBlock`
// + `[About the User]` verbatim (documented, stable). Settings are read directly via
// `getSetting` so this module depends only on `@clawboo/db` (no lib→api inversion).

import { agents, getSetting, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

/** Durable team rules (settings key `team-rules:<teamId>`, JSON `{ content }`). */
function readTeamRulesContent(db: ClawbooDb, teamId: string): string {
  const raw = getSetting(db, `team-rules:${teamId}`)
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { content?: unknown }
    return typeof parsed.content === 'string' ? parsed.content : ''
  } catch {
    return ''
  }
}

/** The user's self-intro (settings key `team-onboarding:<teamId>`, JSON field
 *  `userIntroText`). */
function readUserIntroText(db: ClawbooDb, teamId: string): string {
  const raw = getSetting(db, `team-onboarding:${teamId}`)
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { userIntroText?: unknown }
    return typeof parsed.userIntroText === 'string' ? parsed.userIntroText : ''
  } catch {
    return ''
  }
}

/** Live teammate names for the team, recipient excluded; null when none. */
function buildRosterLine(db: ClawbooDb, teamId: string, selfAgentId: string): string | null {
  const rows = db.select().from(agents).where(eq(agents.teamId, teamId)).all() as Array<{
    id: string
    name: string
    archivedAt?: number | null
  }>
  const mates = rows.filter((a) => !a.archivedAt && a.id !== selfAgentId).map((a) => a.name)
  if (mates.length === 0) return null
  return `Your teammates on this team: ${mates.join(', ')}.`
}

/** The runtime of the recipient agent (drives the OpenClaw coordination block). */
function readAgentRuntime(db: ClawbooDb, agentId: string): string | null {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).get() as
    | { runtime?: string | null }
    | undefined
  return row?.runtime ?? null
}

// The coordination instructions an OpenClaw agent needs to act as a Clawboo team
// member. Native agents already carry this in their stable `systemPrompt` (they
// delegate via a first-class `delegate` TOOL), so this is injected ONLY for OpenClaw
// agents — a vanilla OpenClaw agent otherwise reaches for its native `sessions_spawn`
// / `sessions_yield` tools and spawns its OWN throwaway sub-agents, bypassing the real
// team + Clawboo's board (and erroring). This restores what the browser path injected
// via `buildBooZeroRulesBlock`. The `<delegate>` syntax is exactly what the server
// orchestration engine parses from a terminal turn (runtime-agnostic).
const OPENCLAW_COORDINATION_BLOCK = `[How this team works — read carefully]
You are ONE member of a Clawboo team. The teammates listed above ALREADY EXIST. NEVER create, spawn, or launch new agents or sub-agents — do NOT use sessions_spawn, sessions_yield, or any agent-spawning tool. There is nothing to "spawn"; your team is already here.
To hand a piece of work to a teammate, write a delegation line anywhere in your reply:
<delegate to="@TeammateName">the specific task for them</delegate>
Use one <delegate> block per teammate; you can delegate to several at once. Clawboo delivers each task to that teammate and returns their result to you, so you can then write the final answer for the user. If YOU were handed a specific task, just do it and report the result — do not re-delegate it.
[End How this team works]`

// The behavioral guidance a NATIVE LEADER (Boo Zero, or a native @-mentioned
// responder) needs but does NOT reliably carry — the LIVE native Boo Zero's
// systemPrompt is FROZEN in the DB at create time, so editing the prompt constant
// only reaches NEW agents. Injecting these rules per-turn (the volatile tier) fixes
// the EXISTING leader too (the same "server-side gate covers frozen prompts" pattern
// as the delegation-ack suppression). Covers three reported failures: over-delegating
// trivially-answerable questions, narrating internal/tool state ("the memory is
// empty…"), and appending a repetitive next-steps menu every turn. Injected ONLY for
// a native leader / user-facing turn (a delegated child keeps its own scoped task).
const NATIVE_LEADER_COORDINATION_BLOCK = `[Leading this team — read carefully]
- Answer simple questions and quick clarifications YOURSELF, directly, in a sentence or two. Do NOT delegate or create a task for something you can answer or already know — first check what you and the team have already done.
- Delegate ONLY genuine hands-on, multi-step work (writing code, research, producing or changing a deliverable) by calling the \`delegate\` tool.
- Never narrate your own tool use or internal state (memory, board, searches) to the user; use them silently. If your memory is empty, just proceed.
- Reply with ONE short, plain summary. Suggest a next step only when there is a clear, non-obvious one — do NOT append a menu of options or ask "what's the priority?" every turn.
[End Leading this team]`

// A delegated WORKER's guardrail — the fix for a worker addressing the user directly
// ("Hey boss! Quick question…"). Runtime-agnostic: injected for ANY worker (child-task)
// turn, so it covers a native, OpenClaw, or coding-runtime member. The other half of the
// fix is gating the user's [About the User] self-intro OUT of a child turn (below), which
// is the trigger that makes a worker think it's in a conversation with the user.
const WORKER_COORDINATION_BLOCK = `[Your task — read carefully]
You are executing ONE scoped task delegated to you by your team lead. You CANNOT reach the user — your reply goes to your team lead, not the user. Do the work using your own knowledge and tools. If a detail is missing, make a reasonable assumption and note it — do NOT ask the user or "the boss" a question. When you're done, report a short, concrete result, not a question.
[End Your task]`

/** The coordination block(s) for a team run, or null when none is needed. Composed:
 *  OpenClaw agents get the delegate-protocol + anti-sub-agent block (any turn); a NATIVE
 *  LEADER / user-facing turn gets the behavioral-guidance block; and ANY worker (a
 *  delegated child, `!isLeaderTurn`, any runtime) additionally gets the worker guardrail
 *  (can't-reach-user / assume-and-note / report-to-lead). Multiple blocks are joined. */
function coordinationBlockFor(runtime: string | null, isLeaderTurn: boolean): string | null {
  const blocks: string[] = []
  if (runtime === 'openclaw') blocks.push(OPENCLAW_COORDINATION_BLOCK)
  else if (runtime === 'clawboo-native' && isLeaderTurn) blocks.push(NATIVE_LEADER_COORDINATION_BLOCK)
  if (!isLeaderTurn) blocks.push(WORKER_COORDINATION_BLOCK)
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

/** Compose the volatile team-context preamble for a team run. Returns null when
 *  there is nothing to say (no rules, no intro, no other teammates). */
export function buildServerTeamContext(
  db: ClawbooDb,
  teamId: string,
  selfAgentId: string,
  isLeaderTurn: boolean,
): string | null {
  const rulesContent = readTeamRulesContent(db, teamId).trim()
  const rulesBlock = rulesContent
    ? `[Team Rules — set by the user, authoritative]\n${rulesContent}\n[End Team Rules]`
    : null

  // The user's self-intro rides ONLY the leader / user-facing turn. A delegated child
  // (worker) does not talk to the user, and handing it the user's personal intro is
  // what made a worker treat its task as a conversation and address "the boss".
  const introText = isLeaderTurn ? readUserIntroText(db, teamId).trim() : ''
  const aboutUserBlock = introText ? `[About the User]\n${introText}\n[End About the User]` : null

  const rosterBlock = buildRosterLine(db, teamId, selfAgentId)
  // The coordination rules come AFTER the roster (so the teammate names are in view):
  // OpenClaw agents get the delegate-protocol block; a native LEADER turn gets the
  // behavioral-guidance block; a native worker turn gets nothing.
  const coordinationBlock = coordinationBlockFor(readAgentRuntime(db, selfAgentId), isLeaderTurn)

  const composed = [rulesBlock, aboutUserBlock, rosterBlock, coordinationBlock]
    .filter(Boolean)
    .join('\n\n')
  return composed.length > 0 ? composed : null
}
