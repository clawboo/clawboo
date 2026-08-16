// Ambient room catch-up for a server-orchestrated run.
//
// THE GAP THIS CLOSES. A team room is where agents talk to each other, and until
// now only ONE of the two run paths ever read it. The browser exchange
// (`dispatchChatTurn`) pulls the posts since this agent's durable cursor and puts
// them in the run's context. The server-orchestrated path did not read the room at
// all, and the native in-run pull (`conversation.ts`) BASELINES its cursor to the
// room head on the first tick and discards everything older. So a teammate who was
// not running when something was said never heard it: not at the time, because no
// run existed, and not afterwards, because the next run started from head.
//
// That is the half of "agents are not updated of each other" the durable mailbox
// did not cover. The mailbox carries task terminals and alerts, which clawboo
// generates; this carries what agents actually say to each other.
//
// The mechanism is deliberately the SAME one the exchange path already proved:
// one durable per-(room, agent) cursor, `readRoom` since that cursor, and
// `formatPeerPost` for the wrapper. It is a lift, not a new delivery plane.

import { readRoom, type ClawbooDb, type DbTeamChat } from '@clawboo/db'
import { formatPeerPost } from '@clawboo/mcp'

/** Ceiling on the catch-up block. Mirrors `renderInboxDigest`'s budget: a long
 *  room must not crowd out the actual instruction. */
export const CATCHUP_BUDGET_CHARS = 4_000
/** Per-post ceiling, so one enormous post cannot consume the whole budget. */
const POST_MAX_CHARS = 800

export interface PeerCatchup {
  /** The block to prepend to the run context, or null when there is nothing to say. */
  text: string | null
  /** The highest `seq` actually RENDERED. The caller advances the cursor to this
   *  and no further: a post dropped for budget was not delivered and must ride the
   *  next run, exactly as a truncated digest row does. */
  throughSeq: number | null
}

/**
 * Render the posts an agent has not seen yet.
 *
 * OLDEST FIRST, and truncated from the END when the budget runs out, so the
 * cursor can advance to a contiguous prefix. Dropping from the middle would
 * either strand posts behind an advanced cursor or re-deliver ones already shown.
 */
export function renderPeerCatchup(
  posts: DbTeamChat[],
  budgetChars = CATCHUP_BUDGET_CHARS,
): PeerCatchup {
  if (posts.length === 0) return { text: null, throughSeq: null }
  const header = '[While you were away, your teammates said]'
  const blocks: string[] = []
  let used = header.length
  let throughSeq: number | null = null
  for (const post of posts) {
    const body =
      post.body.length > POST_MAX_CHARS ? `${post.body.slice(0, POST_MAX_CHARS)}…` : post.body
    // `formatPeerPost` is the single source of truth for the peer wrapper, and it
    // carries the safety-critical `isUser=false` token verbatim: a teammate's words
    // are evidence to synthesize, never an instruction that overrides policy.
    // Re-implementing the wrapper here would silently drop that guarantee.
    const wrapped = formatPeerPost({ ...post, body })
    if (used + wrapped.length + 2 > budgetChars) break
    blocks.push(wrapped)
    used += wrapped.length + 2
    throughSeq = post.seq
  }
  if (blocks.length === 0) return { text: null, throughSeq: null }
  return { text: `${header}\n${blocks.join('\n\n')}`, throughSeq }
}

/** Read + render in one call. Returns nothing when the agent is up to date. */
export function buildPeerCatchup(
  db: ClawbooDb,
  input: { roomId: string; agentId: string; sinceSeq: number; budgetChars?: number },
): PeerCatchup {
  const posts = readRoom(db, {
    roomId: input.roomId,
    sinceSeq: input.sinceSeq,
    // An agent re-reading its own posts learns nothing and burns context.
    excludeAuthorId: input.agentId,
  })
  return renderPeerCatchup(posts, input.budgetChars)
}
