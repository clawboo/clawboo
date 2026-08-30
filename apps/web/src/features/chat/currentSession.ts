// Which conversation you are looking at, remembered across reloads.
//
// THE BUG THIS FIXES. `/reset` asks the Gateway for a fresh session and adopts
// the key it returns, but it adopted it in memory only. `GatewayBootstrap`
// rebuilds every agent on load and hard-codes `agent:<id>:<mainKey>`, so a
// reload put the user back on the OLD session: their question and the reply to
// it were both stored correctly under the new key and simply not on screen. It
// reads as a vanished reply, which is the worst possible way for this to fail,
// because the natural conclusion is that the agent lost the work.
//
// WHY LOCAL STORAGE. Which conversation is open is a property of this browser,
// not of the install: it is the same class of state as a scroll position or a
// selected tab. Persisting it server-side would make two windows fight over one
// value, and asking the Gateway on every boot costs a round trip per agent to
// re-derive something the user already told us by clicking.
//
// EVERY PATH TOLERATES FAILURE. Storage can be disabled, full, or hold junk from
// an older build. All of that degrades to "use the main session", which is
// exactly the behaviour this replaces, so a broken store is never worse than no
// store.

const KEY = 'clawboo:chat:session:v1'

type SessionMap = Record<string, string>

function read(): SessionMap {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: SessionMap = {}
    for (const [agentId, sessionKey] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof sessionKey === 'string' && sessionKey) out[agentId] = sessionKey
    }
    return out
  } catch {
    return {}
  }
}

function write(map: SessionMap): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(map))
  } catch {
    // A full or disabled store just means the next reload starts on main.
  }
}

/** Remember the session this agent's chat is now on. */
export function rememberSession(agentId: string, sessionKey: string): void {
  if (!agentId || !sessionKey) return
  write({ ...read(), [agentId]: sessionKey })
}

/** The session this agent's chat was last on, or null to use the default. */
export function recallSession(agentId: string): string | null {
  return read()[agentId] ?? null
}

/** Drop the memory for one agent, so it falls back to its main session. */
export function forgetSession(agentId: string): void {
  const map = read()
  if (!(agentId in map)) return
  delete map[agentId]
  write(map)
}
