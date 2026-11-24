// When a desktop driver (Cua Driver) may run at all.
//
// A desktop driver types into whatever is on its agent's screen, the agent's
// browser included, and reads back what the screen shows. Without agents on
// their own OS user that browser runs as the person running Clawboo, so an
// address the driver types into it (`file:///.../.clawboo/...`) shows that
// person's files, Clawboo's access token and key vault among them. No check on
// a tool's arguments can see a typed address. It is the reason control links
// need agents on their own OS user, and it applies here the same way: whoever
// may use an agent can use what it holds, so the agent must hold only what its
// own user can reach.

import { isAgentUserMode } from '../agentUser/config'

/** Why a desktop driver may not run here, or null when it may. */
export function desktopDriverRefusal(
  displayName: string,
  agentUserMode: boolean = isAgentUserMode(),
): string | null {
  return agentUserMode
    ? null
    : `${displayName} needs agents to run as their own OS user (CLAWBOO_AGENT_USER). It types into the agent's browser, which otherwise runs as you, so it could open your files and Clawboo's own.`
}

// ─── Tools a desktop driver never runs here ──────────────────────────────────

export type RefusedToolKind = 'browser' | 'scripting' | 'install' | 'config'

/**
 * Cua Driver 0.38.0's tools that Clawboo refuses outright, by name, checked
 * against its own tool list (`.github/scripts/cua-driver-mcp-compat/
 * expected-tools.json` at the release's tag). Not offered to any agent, and
 * refused if called anyway; no grant or approval turns them back on.
 *
 * - Browser: they drive Chromium through its DevTools port, which outside a
 *   pipe is a loopback port any local user can open, and they bypass the
 *   per-agent browser's own guards (`page` runs JavaScript in a tab).
 * - Scripting: a script, a list of steps or a replayed recording runs any of
 *   the driver's tools, the refused ones included, in one call.
 * - Install and update: they fetch and install programs.
 * - Config: they read and change the driver's own settings.
 */
const REFUSED_DRIVER_TOOLS: ReadonlyMap<string, RefusedToolKind> = new Map<string, RefusedToolKind>(
  [
    ['browser_click', 'browser'],
    ['browser_dialog', 'browser'],
    ['browser_download', 'browser'],
    ['browser_navigate', 'browser'],
    ['browser_pointer', 'browser'],
    ['browser_prepare', 'browser'],
    ['browser_select', 'browser'],
    ['browser_set_input_files', 'browser'],
    ['browser_type', 'browser'],
    ['get_browser_state', 'browser'],
    ['page', 'browser'],
    ['run_script', 'scripting'],
    ['run_steps', 'scripting'],
    ['replay_trajectory', 'scripting'],
    ['install_extension', 'install'],
    ['install_ffmpeg', 'install'],
    ['check_for_update', 'install'],
    ['get_config', 'config'],
    ['set_config', 'config'],
  ],
)

/**
 * Words that mark a tool of one of those kinds in any version: an
 * administrator may name a driver of another release (`cuaDriverPath`), and a
 * new tool in one of these families is refused before anyone has looked at it.
 * Matched against each part of the name, split at underscores, dashes, dots and
 * camelCase humps (`browserNavigate` is `browser` and `navigate`). A part that
 * holds `browser` or ends in `script` counts wherever it sits (`webbrowser`,
 * `applescript`).
 */
const REFUSED_WORDS: readonly [RegExp, RefusedToolKind][] = [
  [/^(\w*browsers?\w*|page|pages|tab|tabs|url|urls|cdp|devtools)$/, 'browser'],
  [
    /^(\w*scripts?|scripting|steps|trajectory|replay|eval|evaluate|exec|execute|js|shell|command|commands|terminal)$/,
    'scripting',
  ],
  [
    /^(install|installer|uninstall|update|updates|upgrade|extension|extensions|plugin|plugins)$/,
    'install',
  ],
  [/^(config|configuration|settings|preferences|prefs)$/, 'config'],
]

/** Which refused kind a desktop driver's tool is, or null when it may be offered. */
export function refusedDriverToolKind(toolName: string): RefusedToolKind | null {
  const name = toolName.trim()
  const known = REFUSED_DRIVER_TOOLS.get(name.toLowerCase())
  if (known) return known
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  for (const part of parts) {
    for (const [word, kind] of REFUSED_WORDS) if (word.test(part)) return kind
  }
  return null
}

const KIND_WORDS: Record<RefusedToolKind, string> = {
  browser: 'its browser tools',
  scripting: 'its scripting tools',
  install: 'its install and update tools',
  config: 'its settings tools',
}

/** Why a desktop driver's tool is refused here, or null when it may run. */
export function desktopDriverToolRefusal(displayName: string, toolName: string): string | null {
  const kind = refusedDriverToolKind(toolName)
  return kind
    ? `Clawboo refuses ${displayName}'s ${toolName}: it never runs ${KIND_WORDS[kind]}. Use the agent's own browser tools for web pages.`
    : null
}
