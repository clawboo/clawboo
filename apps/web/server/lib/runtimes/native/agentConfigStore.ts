// AgentConfig + agent-file persistence for native agents — settings KV rows
// (zero-migration; the per-agent prefixes are swept by the agents REST layer's
// perAgentSettingKeys on delete). The config is zod-validated on every load so
// a corrupt blob degrades to the default config instead of crashing a run.

import { DEFAULT_AGENT_CONFIG, parseAgentConfig, type AgentConfig } from '@clawboo/adapter-native'
import { getSetting, setSetting, type ClawbooDb } from '@clawboo/db'

export const NATIVE_CONFIG_KEY_PREFIX = 'native-agent-config:'
export const NATIVE_FILE_KEY_PREFIX = 'native-agent-file:'

export function nativeConfigKey(agentId: string): string {
  return `${NATIVE_CONFIG_KEY_PREFIX}${agentId}`
}

export function nativeFileKey(agentId: string, name: string): string {
  return `${NATIVE_FILE_KEY_PREFIX}${agentId}:${name}`
}

/** Stored config, or null when absent/corrupt (caller decides the fallback). */
export function loadAgentConfig(db: ClawbooDb, agentId: string): AgentConfig | null {
  return parseAgentConfig(getSetting(db, nativeConfigKey(agentId)))
}

/** Stored config with the default fallback (the run path's read). */
export function loadAgentConfigOrDefault(db: ClawbooDb, agentId: string): AgentConfig {
  return loadAgentConfig(db, agentId) ?? { ...DEFAULT_AGENT_CONFIG, id: agentId }
}

export function saveAgentConfig(db: ClawbooDb, config: AgentConfig): void {
  setSetting(db, nativeConfigKey(config.id), JSON.stringify(config))
}

export function readNativeAgentFile(db: ClawbooDb, agentId: string, name: string): string {
  return getSetting(db, nativeFileKey(agentId, name)) ?? ''
}

export function writeNativeAgentFile(
  db: ClawbooDb,
  agentId: string,
  name: string,
  content: string,
): void {
  setSetting(db, nativeFileKey(agentId, name), content)
}
