// The session key a person's 1:1 chat with one server-run agent lives under.
//
// One definition for every writer and reader: the registry hands it to the
// browser as the agent's `sessionKey`, the 1:1 drain persists and streams under
// it, and a reset recognises it. A Clawboo Native agent keeps its historical
// `agent:<id>:native`; Claude Code, Codex and Hermes (and the flagged mock
// harness) use `agent:<id>:<runtime>`. OpenClaw agents are not covered here:
// their 1:1 chat lives in the Gateway under the Gateway's own key.

import { nativeChatSessionKey } from '@clawboo/team-orchestration'

const NATIVE_RUNTIME = 'clawboo-native'

/** The last segment of a 1:1 key, per server-run runtime. */
const DIRECT_CHAT_SUFFIXES = new Set(['native', 'claude-code', 'codex', 'hermes', 'clawboo-mock'])

/** The 1:1 chat key for `agentId` on `runtime`. A missing runtime gets the native
 *  key, which is what the 1:1 routes used before they knew any other runtime. */
export function directChatSessionKey(agentId: string, runtime: string | null | undefined): string {
  return runtime && runtime !== NATIVE_RUNTIME
    ? `agent:${agentId}:${runtime}`
    : nativeChatSessionKey(agentId)
}

/** The agent id of a server-run 1:1 key, or null when `sessionKey` is not one. */
export function agentIdFromDirectChatKey(sessionKey: string): string | null {
  const m = /^agent:(.+):([^:]+)$/.exec(sessionKey)
  return m && DIRECT_CHAT_SUFFIXES.has(m[2]!) ? m[1]! : null
}
