const SESSION_KEY_AGENT_RE = /^agent:([^:]+):/

/** Extracts the agentId from a sessionKey of format `agent:<agentId>:<sessionName>`. */
export function agentIdFromSessionKey(sessionKey: string): string | null {
  const m = SESSION_KEY_AGENT_RE.exec(sessionKey)
  return m?.[1] ?? null
}
