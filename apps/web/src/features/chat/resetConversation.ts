// Starting a fresh conversation without losing the last one.
//
// `/reset` and `/new` both mean the same thing to a person: clear the desk. The
// runtime underneath treats them as synonyms too, and keeps both names only so an
// install can choose to re-read its startup files on one and not the other.
//
// WHAT USED TO HAPPEN, AND WHY IT WAS TWO DIFFERENT BUGS. On a native agent the
// command DELETED every stored message, so a person clearing their screen lost the
// conversation permanently. On a Gateway agent it asked for a brand new session
// key and moved the chat onto it, which left the old conversation stranded under a
// key nothing points at any more. Same two words, two different kinds of loss.
//
// WHAT HAPPENS NOW. The conversation moves aside under an archive key and the chat
// stays on the SAME key it has always been on. That is what the runtime does with
// its own transcripts, and it means the address of a chat never changes: no
// bookkeeping to remember which conversation an agent is "really" on, and nothing
// to strand.

import { apiFetch } from '@clawboo/control-client'

import { useChatStore } from '@/stores/chat'

/**
 * Words that mean "clear the desk". Both, because both are already documented.
 *
 * Case-insensitive: a person typing on a phone gets `/Reset` from autocapitalise,
 * and treating that as an ordinary message hands the boo a literal "/Reset" to
 * interpret instead of clearing the chat.
 */
export function isResetCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase()
  return trimmed === '/reset' || trimmed === '/new'
}

/** What the chat says after a reset. Plain enough to need no explanation. */
export const RESET_NOTICE = 'Starting fresh. Your earlier conversation is saved.'

/**
 * Set the current conversation aside and empty the chat.
 *
 * The screen clears either way, and the return value says whether the save landed.
 * A failed archive is a server that could not be reached, and refusing to clear on
 * top of that would leave the person looking at a chat that ignored them. The
 * messages are still on disk under the live key, so the next load shows them again
 * rather than losing anything, which is the opposite of what "saved" implies and
 * is why the caller has to be able to tell the difference.
 */
export async function archiveConversation(sessionKey: string): Promise<boolean> {
  useChatStore.getState().clearTranscript(sessionKey)
  try {
    const res = await apiFetch(
      `/api/chat-history/archive?sessionKey=${encodeURIComponent(sessionKey)}`,
      {
        method: 'POST',
      },
    )
    return res.ok
  } catch {
    // Nothing was destroyed, so there is nothing to roll back. The caller says so
    // rather than promising a save that did not happen.
    return false
  }
}

/** What the chat says when the screen cleared but the save did not land. */
export const RESET_UNSAVED_NOTICE =
  'The chat is clear, but your earlier conversation could not be saved just now. It is still on disk and will be back next time this chat loads.'
