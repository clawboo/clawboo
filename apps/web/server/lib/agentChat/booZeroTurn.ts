// What Boo Zero reads for a message in its one-to-one chat, when the server runs that
// chat: its rules, then what the team the message names has been doing, then the words.
// Built here, where the turn runs, so every client gets the same turn from the person's
// words and a `teamId`. The server also knows for itself when a turn carries words that
// are not the person's (the team's activity), which is what puts it under the hand-off
// fence (see chatHandOffs).

import type { ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { BOO_ZERO_RULES_OPENER, buildBooZeroRulesBlock } from '@clawboo/team-orchestration'

import { buildTeamActivitySummary, TEAM_ACTIVITY_OPENER } from '../teamChat/teamActivitySummary'

const log = createLogger('boo-zero-turn')

export interface BooZeroTurn {
  /** What the model reads. */
  message: string
  /** It carries what a team has been doing: words that are not the person's. */
  carriesTeamActivity: boolean
}

export interface BooZeroTurnInput {
  /** The name Boo Zero goes by (`booZeroDisplayName`). */
  displayName: string
  /** Whether this chat acts on a hand-off in a reply (`chatHandsOff`). */
  handOffs: boolean
  /** The message as sent. */
  words: string
  /** The team the message names, when its sender may read that team. */
  teamId: string | null
}

/**
 * Boo Zero's turn for a message: its rules, then the named team's activity, then the
 * words. Never throws, since the message is already stored and its turn has to run: a
 * team whose activity cannot be read adds nothing, as a team with nothing to report does.
 */
export async function buildBooZeroTurn(
  db: ClawbooDb,
  input: BooZeroTurnInput,
): Promise<BooZeroTurn> {
  const { words, teamId } = input
  // A dashboard tab opened before this release builds the rules and the activity itself
  // and sends them in the message. For one release that message is taken as sent: no
  // second block, and the fence reads the message as it used to. Remove after that.
  if (words.startsWith(BOO_ZERO_RULES_OPENER)) {
    return { message: words, carriesTeamActivity: words.includes(TEAM_ACTIVITY_OPENER) }
  }
  const rules = buildBooZeroRulesBlock({
    displayName: input.displayName,
    handOffs: input.handOffs,
  })
  let activity: string | null = null
  if (teamId) {
    try {
      activity = (await buildTeamActivitySummary(db, teamId))?.trim() || null
    } catch (err) {
      log.warn({ err, teamId }, "could not read a team's activity for Boo Zero")
    }
  }
  return {
    message: [rules, activity, words].filter((s): s is string => Boolean(s)).join('\n\n'),
    carriesTeamActivity: activity !== null,
  }
}
