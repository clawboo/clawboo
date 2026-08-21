// AgentConfig + agent-file persistence for native agents — settings KV rows
// (zero-migration; the per-agent prefixes are swept by the agents REST layer's
// perAgentSettingKeys on delete). The config is zod-validated on every load so
// a corrupt blob degrades to the default config instead of crashing a run.

import {
  COORDINATION_TOOLSET,
  DEFAULT_AGENT_CONFIG,
  isFrozenTeamToolset,
  parseAgentConfig,
  type AgentConfig,
} from '@clawboo/adapter-native'
import { getSetting, setSetting, settings, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { like } from 'drizzle-orm'

const log = createLogger('native-agent-config')

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

/** Marks the one-shot coordination-toolset repair as done, so it never re-runs. */
export const SETTING_COORDINATION_TOOLSET_UPGRADED = 'coordination-toolset-upgraded'

/**
 * ONE-SHOT repair of agents created before the coordination overhaul.
 *
 * Every pre-overhaul product path froze `{tasks:false, teamchat:false}` onto the
 * agents it created, which switched off the entire coordination plane: the
 * conversation's automatic peer-inbox pull became a no-op and a leader could not
 * read its own board. New agents now ship the coordination surface, but existing
 * installs would stay silently broken forever — there is no migration ladder.
 *
 * Runs ONCE (guarded by a settings flag), rewriting only configs that still match
 * the exact frozen signature. Deliberately not a load-time coercion: after this
 * runs, turning these tools off is a choice that sticks.
 *
 * Returns how many agents were repaired. Best-effort; never throws.
 */
export function upgradeFrozenToolsets(db: ClawbooDb): number {
  if (getSetting(db, SETTING_COORDINATION_TOOLSET_UPGRADED)) return 0
  let repaired = 0
  try {
    const rows = db
      .select()
      .from(settings)
      .where(like(settings.key, `${NATIVE_CONFIG_KEY_PREFIX}%`))
      .all() as Array<{ key: string; value: string }>
    for (const row of rows) {
      const config = parseAgentConfig(row.value)
      if (!config || !isFrozenTeamToolset(config.tools)) continue
      // Repair ONLY the two coordination axes the frozen paths broke — a user's
      // deliberate memory/tools toggles must survive the sweep.
      saveAgentConfig(db, {
        ...config,
        tools: {
          ...config.tools,
          tasks: COORDINATION_TOOLSET.tasks,
          teamchat: COORDINATION_TOOLSET.teamchat,
        },
      })
      repaired++
    }
    setSetting(db, SETTING_COORDINATION_TOOLSET_UPGRADED, String(Date.now()))
  } catch (err) {
    // A failed sweep leaves the flag unset, so the next boot retries. Log it
    // rather than swallowing: the caller wraps this in `safeStart`, which only
    // reports a THROW, so a silent catch here turns a permanently-failing repair
    // into zero output while every pre-overhaul agent stays without its
    // coordination tools. Partial progress is kept (repaired rows are saved).
    log.error({ err, repaired }, 'coordination-toolset repair failed; will retry next boot')
  }
  return repaired
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
