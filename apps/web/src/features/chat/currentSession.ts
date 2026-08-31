// Which conversation an agent's chat opens on.
//
// A chat now keeps ONE address for its whole life: starting fresh moves the old
// messages aside and leaves the key alone (see resetConversation.ts). Nothing
// needs remembering, so nothing is written here any more.
//
// WHAT IS STILL READ, AND WHY. Resets used to ask the Gateway for a brand new key
// and move the chat onto it, storing that key here so a reload would not drop the
// person back on the conversation they had just left. Anyone who reset before this
// changed is still on one of those keys, with real messages under it. Dropping the
// read would strand them on their old main conversation and their recent replies
// would read as vanished, which is the worst possible way for this to fail: the
// natural conclusion is that the agent lost the work.
//
// EVERY PATH TOLERATES FAILURE. Storage can be disabled, full, or hold junk from an
// older build. All of that degrades to "use the main session", which is what a
// chat with no stored key does anyway, so a broken store is never worse than none.

const KEY = 'clawboo:chat:session:v1'

/** The session this agent's chat was last moved onto, or null for its main one. */
export function recallSession(agentId: string): string | null {
  if (!agentId) return null
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>)[agentId]
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}
