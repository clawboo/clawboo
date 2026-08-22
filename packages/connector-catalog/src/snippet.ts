// Copy-paste config snippets, one per runtime dialect.
//
// SCOPE, and it is narrow on purpose: these strings are for a HUMAN to paste into
// their own config file. Nothing here writes, merges, or parses an existing file.
// That distinction matters — the in-repo `capabilitySource/transcoder.ts` does
// attempt a merge, and its JSON path resets to `{}` on a parse failure, which
// would delete every other server in the file. A generator that only ever
// produces a fresh block cannot have that bug.
//
// Pure string building, no deps, browser-safe: the connector browser renders
// these with no server round-trip.

import type { ConnectorDefinition } from './types'

/** The config dialects clawboo can emit a paste-ready block for. */
export type SnippetDialect = 'claude-code' | 'codex' | 'vscode'

export interface SnippetResult {
  dialect: SnippetDialect
  /** Where the user pastes it. */
  file: string
  /** `json` | `toml` — drives syntax highlighting. */
  language: 'json' | 'toml'
  body: string
  /**
   * Env vars the user must set themselves. Present so the UI can say "you will
   * also need GITHUB_TOKEN" instead of the user discovering it from a crash.
   * NAMES only — a value never enters a snippet.
   */
  requiredEnv: string[]
}

/** TOML basic strings share JSON's escaping for the inputs we emit. */
function tomlString(s: string): string {
  return JSON.stringify(s)
}

/**
 * A safe TOML table key. `[mcp_servers.a.b]` declares a table `b` NESTED under
 * `a`, so a dotted slug would silently register a server under the wrong name —
 * quoting is what keeps it one key.
 */
function tomlKey(slug: string): string {
  return /^[A-Za-z0-9_-]+$/.test(slug) ? slug : JSON.stringify(slug)
}

function envBlock(def: ConnectorDefinition): Record<string, string> | undefined {
  const keys = def.auth.inputs.map((i) => i.key)
  if (keys.length === 0) return undefined
  // `${VAR}` interpolation, so the snippet never contains a literal credential
  // and can be pasted into a file the user commits.
  return Object.fromEntries(keys.map((k) => [k, `\${${k}}`]))
}

function requiredEnv(def: ConnectorDefinition): string[] {
  return def.auth.inputs.filter((i) => i.required).map((i) => i.key)
}

/** Claude Code / VS Code JSON entry — the value under `mcpServers[slug]`. */
function jsonEntry(def: ConnectorDefinition): Record<string, unknown> {
  if (def.launch.transport === 'streamable-http') {
    // Claude Code aliases `streamable-http` to `http`; `http` is the portable spelling.
    return { type: 'http', url: def.launch.url }
  }
  const env = envBlock(def)
  return {
    type: 'stdio',
    command: def.launch.command,
    args: def.launch.args,
    ...(env ? { env } : {}),
  }
}

/**
 * Build a paste-ready block.
 *
 * Codex over HTTP is emitted as `url = …`, NOT refused. `transcoder.ts:85` throws
 * `NonStdioUnsupportedError` for exactly this case while the repo's own
 * `codexDriver.ts` writes that block in production — the driver is right and the
 * transcoder is wrong, so this follows the driver.
 */
export function connectorSnippet(def: ConnectorDefinition, dialect: SnippetDialect): SnippetResult {
  const env = requiredEnv(def)

  if (dialect === 'codex') {
    const key = tomlKey(def.slug)
    const lines = [`[mcp_servers.${key}]`]
    if (def.launch.transport === 'streamable-http') {
      lines.push(`url = ${tomlString(def.launch.url)}`)
    } else {
      lines.push(`command = ${tomlString(def.launch.command)}`)
      lines.push(`args = [${def.launch.args.map(tomlString).join(', ')}]`)
      if (env.length > 0) {
        lines.push(`env_vars = [${env.map(tomlString).join(', ')}]`)
      }
    }
    return {
      dialect,
      file: '~/.codex/config.toml',
      language: 'toml',
      body: lines.join('\n'),
      requiredEnv: env,
    }
  }

  const body = JSON.stringify({ mcpServers: { [def.slug]: jsonEntry(def) } }, null, 2)
  return {
    dialect,
    file: dialect === 'vscode' ? '.vscode/mcp.json' : '.mcp.json',
    language: 'json',
    body,
    requiredEnv: env,
  }
}

export const SNIPPET_DIALECTS: readonly { id: SnippetDialect; label: string }[] = Object.freeze([
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'vscode', label: 'VS Code' },
])
