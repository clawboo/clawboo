// Starting fresh without losing the conversation.
//
// WHAT THIS MEANS NOW. `/reset` and `/new` end what the BOO is carrying, not what
// the person can see. Every message stays exactly where it is, in the same chat, and
// a divider marks the point past which the boo is no longer holding the thread. A
// teammate who says "let us start fresh on this" does not erase your shared history;
// they stop carrying the old thread in their head, and you can both still look back.
//
// WHAT THIS REPLACED, TWICE. The first version deleted every stored message on the
// native path and, on the Gateway path, asked for a brand new session key and moved
// the chat onto it, stranding the old conversation under a key nothing pointed at.
// The second version moved the messages aside into an archive, which fixed the loss
// but put them somewhere the product could not reach. Not moving them at all is both
// simpler and the thing people actually expect: every comparable product keeps the
// old conversation reachable, and the cheapest way to be reachable is to never leave.
//
// WHAT THE BOO STILL KNOWS AFTERWARDS. Its character survives in full: the system
// prompt is rebuilt from the agent's own files on every run, so personality, role and
// instructions come back untouched. Facts do not come back automatically. Memory is a
// set of tools the boo chooses to call, so the divider promises only what is true.

import { apiFetch } from '@clawboo/control-client'
import type { TranscriptEntry } from '@clawboo/protocol'

/**
 * Words that mean "clear the desk". Both, because both are already documented.
 *
 * Case-insensitive: a phone autocapitalises the first letter, and treating `/Reset`
 * as an ordinary message hands the boo a literal "/Reset" to interpret instead.
 */
export function isResetCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase()
  return trimmed === '/reset' || trimmed === '/new'
}

/** Shown when the chat could not reach the server, so nothing actually reset. */
export const RESET_FAILED_NOTICE =
  'Could not start fresh just now: the server could not be reached. Your boo is still carrying the conversation above.'

/**
 * End the model's conversation on every listed session, and return the divider.
 *
 * A team room resets each teammate's own session but shows ONE divider, because the
 * person is looking at a single merged timeline.
 *
 * Returns null when the request failed, and the caller says so rather than drawing a
 * divider that claims something the boo did not do. Nothing is destroyed either way,
 * so there is nothing to roll back.
 */
export async function resetConversationContext(
  sessionKeys: string[],
  noticeSessionKey?: string,
): Promise<TranscriptEntry | null> {
  try {
    const res = await apiFetch('/api/chat-history/reset-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKeys,
        ...(noticeSessionKey ? { noticeSessionKey } : {}),
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { entry?: TranscriptEntry }
    return body.entry ?? null
  } catch {
    return null
  }
}
