// Agent-file persistence for the generic RuntimeAgentSource (claude-code / codex
// / hermes agent records) — settings KV rows, mirroring the native store. The
// key is agent-id-scoped (NOT source-scoped) so `perAgentSettingKeys(agentId)`
// can sweep it in lock-step on delete without knowing the runtime. Files are
// stored for the agent detail editor; the coding-runtime drivers ignore them.

import { getSetting, setSetting, type ClawbooDb } from '@clawboo/db'

export const RUNTIME_AGENT_FILE_KEY_PREFIX = 'runtime-agent-file:'

export function runtimeAgentFileKey(agentId: string, name: string): string {
  return `${RUNTIME_AGENT_FILE_KEY_PREFIX}${agentId}:${name}`
}

export function readRuntimeAgentFile(db: ClawbooDb, agentId: string, name: string): string {
  return getSetting(db, runtimeAgentFileKey(agentId, name)) ?? ''
}

export function writeRuntimeAgentFile(
  db: ClawbooDb,
  agentId: string,
  name: string,
  content: string,
): void {
  setSetting(db, runtimeAgentFileKey(agentId, name), content)
}
