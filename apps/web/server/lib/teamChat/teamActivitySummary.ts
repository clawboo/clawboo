// buildTeamActivitySummary — a compact, on-demand snapshot of what a team has been
// doing, for injection into Boo Zero's PERSONAL chat when the user `@`-mentions that
// team. It answers "what's happening in that team" from durable SERVER state (the
// team's Boo-Zero brief + its board + its recent team chat), so it works regardless
// of what the browser has loaded, unlike the old client-store transcript read.
//
// Deliberately separate from `buildServerTeamContext` (contextPreamble.ts), which is
// the cache-sensitive per-turn rules/roster block prepended to every orchestrated
// run. This is a one-off read block, composed brief -> board -> chat, bounded, and
// returns null when the team has nothing to report.

import {
  agents,
  booZeroTeamBriefs,
  listRecentChatMessages,
  listTasks,
  SqliteMemoryStore,
  teams,
  type ClawbooDb,
  type Fact,
} from '@clawboo/db'
import type { TranscriptEntry } from '@clawboo/protocol'
import { agentIdFromSessionKey, shouldDropAssistantTurn } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { resolveTeamSessionKeys } from '../../api/teamChatStream'

/** Total character budget for the whole block. The board summary is kept whole (short
 *  + highest-signal); the brief is capped (a team's stored brief can be a long
 *  auto-generated manifest, not a summary); the recent-chat section gets whatever
 *  budget remains. */
const MAX_CHARS = 2500
const BRIEF_CAP = 900
const CHAT_MESSAGE_LIMIT = 30
const LINE_TEXT_CAP = 200
const MEMORY_FACT_LIMIT = 5
const MEMORY_CONTENT_CAP = 160

function readTeamName(db: ClawbooDb, teamId: string): string {
  const row = db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).get() as
    | { name: string }
    | undefined
  return row?.name ?? teamId
}

function readTeamBrief(db: ClawbooDb, teamId: string): string {
  const row = db
    .select({ content: booZeroTeamBriefs.content })
    .from(booZeroTeamBriefs)
    .where(eq(booZeroTeamBriefs.teamId, teamId))
    .get() as { content: string } | undefined
  return (row?.content ?? '').trim()
}

/** id -> display name for every agent (Boo Zero + members of any team can appear in a
 *  team's transcript). */
function buildAgentNameMap(db: ClawbooDb): Map<string, string> {
  const rows = db.select({ id: agents.id, name: agents.name }).from(agents).all() as Array<{
    id: string
    name: string
  }>
  return new Map(rows.map((r) => [r.id, r.name]))
}

function humanStatus(status: string): string {
  return status.replace(/_/g, ' ')
}

/** UTC HH:MM — deterministic + locale-independent; exact wall-clock is not important
 *  for model context, ordering + recency are. */
function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}

/** Board summary: total + counts by status + the most-recent ~5 tasks. Whole (kept
 *  regardless of the char budget — it is cheap + the highest-signal "what did they
 *  do"). Null when the team has no tasks. */
function buildBoardBlock(db: ClawbooDb, teamId: string): string | null {
  const tasks = listTasks(db, { teamId }) // DESC by updatedAt, drops soft-deleted
  if (tasks.length === 0) return null
  const counts = new Map<string, number>()
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
  const countStr = [...counts.entries()].map(([s, n]) => `${n} ${humanStatus(s)}`).join(', ')
  const recent = tasks.slice(0, 5).map((t) => {
    const title = t.title.length > 80 ? t.title.slice(0, 80) + '…' : t.title
    return `- ${title} (${humanStatus(t.status)})`
  })
  const plural = tasks.length === 1 ? 'task' : 'tasks'
  return `Board (${tasks.length} ${plural}: ${countStr}):\n${recent.join('\n')}`
}

/** Recent team chat: the last N meaningful turns across the team's sessions (members +
 *  Boo Zero), formatted `[HH:MM] <who>: <text>`. Truncates within the section (drops
 *  oldest lines) to fit `maxChars`. Null when there is no meaningful chat. */
function buildChatBlock(db: ClawbooDb, teamId: string, maxChars: number): string | null {
  if (maxChars <= 0) return null
  const sessionKeys = resolveTeamSessionKeys(db, teamId)
  const rows = listRecentChatMessages(db, { sessionKeys, limit: CHAT_MESSAGE_LIMIT })
  if (rows.length === 0) return null
  const nameMap = buildAgentNameMap(db)

  const lines: string[] = []
  for (const row of rows) {
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(row.data) as TranscriptEntry
    } catch {
      continue // a malformed row must not sink the whole summary
    }
    if (!entry || typeof entry.text !== 'string') continue
    const text = entry.text.trim()
    if (!text) continue
    if (entry.kind === 'meta') continue
    if (text.startsWith('[Team Update]')) continue // relay envelope, not real activity
    if (entry.role === 'assistant' && shouldDropAssistantTurn(text)) continue // control tokens

    const agentId = agentIdFromSessionKey(row.sessionKey)
    const who =
      entry.role === 'user' ? 'User' : agentId ? (nameMap.get(agentId) ?? agentId) : 'Agent'
    const clipped = text.length > LINE_TEXT_CAP ? text.slice(0, LINE_TEXT_CAP) + '…' : text
    lines.push(`[${clock(row.timestampMs)}] ${who}: ${clipped}`)
  }
  if (lines.length === 0) return null

  // Fit within the section's budget: drop oldest lines until it fits.
  while (lines.length > 0) {
    const block = `Recent activity (last ${lines.length} messages):\n${lines.join('\n')}`
    if (block.length <= maxChars) return block
    lines.shift()
  }
  return null
}

/** The team's SAVED memory: the durable facts its agents recorded (via the Memory
 *  MCP / auto-save), team-scoped. `browseMemory` is inclusive (team + global); we keep
 *  only the team-scoped rows so this reads as THIS team's knowledge, not cross-team
 *  noise. The most-recently-updated few, each content-capped. Null when none. No
 *  embedding provider needed — browse is a plain scoped read. */
async function buildMemoryBlock(db: ClawbooDb, teamId: string): Promise<string | null> {
  let facts: Fact[]
  try {
    const store = new SqliteMemoryStore(db)
    facts = await store.browseMemory({ scope: { teamId }, limit: 20 })
  } catch {
    return null // memory is best-effort; never sink the summary
  }
  const teamFacts = facts.filter((f) => f.scopeTeamId === teamId).slice(0, MEMORY_FACT_LIMIT)
  if (teamFacts.length === 0) return null
  const lines = teamFacts.map((f) => {
    const content =
      f.content.length > MEMORY_CONTENT_CAP ? f.content.slice(0, MEMORY_CONTENT_CAP) + '…' : f.content
    return `- ${f.title}: ${content}`
  })
  return `Saved knowledge:\n${lines.join('\n')}`
}

/**
 * A bounded "what has this team been doing" block for injection into Boo Zero's
 * personal chat. Composes brief -> board -> saved memory -> recent chat; returns null
 * when the team has no brief, board, saved memory, or meaningful chat (so `@`-ing an
 * untouched team stays honestly empty).
 */
export async function buildTeamActivitySummary(
  db: ClawbooDb,
  teamId: string,
): Promise<string | null> {
  const parts: string[] = []
  let used = 0

  const brief = readTeamBrief(db, teamId)
  if (brief) {
    const clipped = brief.length > BRIEF_CAP ? brief.slice(0, BRIEF_CAP) + '…' : brief
    const b = `Brief:\n${clipped}`
    parts.push(b)
    used += b.length + 2
  }

  const board = buildBoardBlock(db, teamId)
  if (board) {
    parts.push(board)
    used += board.length + 2
  }

  const memory = await buildMemoryBlock(db, teamId)
  if (memory) {
    parts.push(memory)
    used += memory.length + 2
  }

  // Header + footer + separators overhead reserved before the chat budget. Brief,
  // board, and saved memory are kept whole; the recent-chat section gets the rest.
  const chatBudget = MAX_CHARS - used - 80
  const chat = buildChatBlock(db, teamId, chatBudget)
  if (chat) parts.push(chat)

  if (parts.length === 0) return null
  const name = readTeamName(db, teamId)
  return `[Team Activity: ${name}]\n\n${parts.join('\n\n')}\n[End Team Activity]`
}
