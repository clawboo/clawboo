// MCP-config transcoder — the `external-write` write-path primitive. Maps a
// runtime-neutral CanonicalMcpServer spec to each runtime's dialect (Claude Code
// inline mcpServers / Codex TOML [mcp_servers] / Hermes mcp.json), with a
// COMMENT-PRESERVING merge so a hand-edited config file is never clobbered.
//
// Wired as the dispatch primitive for the external-write tier. No runtime exposes
// a clawboo-managed PERSISTENT connector store this session (Hermes mcp.json is
// regenerated each run; Codex's home is ephemeral + auth-blocked), so it has no
// live runtime surface yet — it is built + unit-tested as the seam a future
// persistent connector store plugs into.

import type { CanonicalMcpServer } from '@clawboo/capability-registry'

export type McpDialect = 'claude-code' | 'codex' | 'hermes'

/** A non-stdio server handed to a stdio-only dialect (Codex). */
export class NonStdioUnsupportedError extends Error {
  constructor(public readonly dialect: McpDialect) {
    super(`dialect '${dialect}' supports stdio MCP servers only`)
    this.name = 'NonStdioUnsupportedError'
  }
}

/** A server name / env key that is not a safe identifier — interpolating it raw
 *  would let it break out of the TOML header (`[mcp_servers.<name>]`) or JSON key
 *  and inject an attacker-controlled server block. */
export class InvalidMcpIdentError extends Error {
  constructor(public readonly value: string) {
    super(`invalid MCP identifier: ${JSON.stringify(value)}`)
    this.name = 'InvalidMcpIdentError'
  }
}

/** A non-clawboo capability may not name itself `clawboo-*` — that namespace is
 *  the trusted MCP spine (tasks/memory/tools/teamchat); allowing it would let an
 *  external write clobber a spine entry via the same-name merge. */
export class ReservedMcpServerNameError extends Error {
  constructor(public readonly name: string) {
    super(`reserved MCP server name: ${JSON.stringify(name)}`)
    this.name = 'ReservedMcpServerNameError'
  }
}

const VALID_MCP_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Make header/key interpolation structurally safe regardless of dialect: a name
 *  is a bounded safe-char identifier and not in the reserved `clawboo-` namespace;
 *  every env key is a shell/TOML-safe identifier. */
function assertSafeServer(spec: CanonicalMcpServer): void {
  if (!VALID_MCP_NAME.test(spec.name)) throw new InvalidMcpIdentError(spec.name)
  if (spec.name.toLowerCase().startsWith('clawboo-'))
    throw new ReservedMcpServerNameError(spec.name)
  for (const k of Object.keys(spec.env ?? {})) {
    if (!VALID_ENV_KEY.test(k)) throw new InvalidMcpIdentError(k)
  }
}

/** Guard a merge target name (the only field a merge interpolates into the file). */
function assertSafeMergeName(name: string): void {
  if (!VALID_MCP_NAME.test(name)) throw new InvalidMcpIdentError(name)
  if (name.toLowerCase().startsWith('clawboo-')) throw new ReservedMcpServerNameError(name)
}

function tomlString(s: string): string {
  return JSON.stringify(s) // TOML basic strings share JSON's escaping for our inputs
}

/** Claude Code / Hermes JSON entry (the value under `mcpServers[name]`). */
export function toJsonEntry(spec: CanonicalMcpServer): Record<string, unknown> {
  assertSafeServer(spec)
  if (spec.transport === 'http') {
    return { type: 'http', url: spec.url ?? '' }
  }
  return {
    type: 'stdio',
    command: spec.command ?? '',
    args: spec.args ?? [],
    ...(spec.env ? { env: spec.env } : {}),
  }
}

/** Codex TOML block — stdio only (rejects http). */
export function toCodexTomlBlock(spec: CanonicalMcpServer): string {
  if (spec.transport !== 'stdio') throw new NonStdioUnsupportedError('codex')
  assertSafeServer(spec)
  const lines = [`[mcp_servers.${spec.name}]`, `command = ${tomlString(spec.command ?? '')}`]
  lines.push(`args = [${(spec.args ?? []).map(tomlString).join(', ')}]`)
  if (spec.env && Object.keys(spec.env).length > 0) {
    const pairs = Object.entries(spec.env)
      .map(([k, v]) => `${k} = ${tomlString(v)}`)
      .join(', ')
    lines.push(`env = { ${pairs} }`)
  }
  return lines.join('\n')
}

/**
 * Merge a JSON mcp-config string (Claude / Hermes `{ mcpServers: {...} }`),
 * adding/overwriting one server while preserving every existing entry. Returns a
 * 2-space-pretty JSON string.
 */
export function mergeJsonMcpServers(
  existing: string | null | undefined,
  name: string,
  entry: Record<string, unknown>,
): string {
  assertSafeMergeName(name)
  let parsed: { mcpServers?: Record<string, unknown> } = {}
  if (existing && existing.trim()) {
    try {
      parsed = JSON.parse(existing) as { mcpServers?: Record<string, unknown> }
    } catch {
      parsed = {}
    }
  }
  const servers = { ...(parsed.mcpServers ?? {}) }
  servers[name] = entry
  return JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)
}

/**
 * Comment-preserving TOML merge: replace the `[mcp_servers.<name>]` block in
 * place (or append it), keeping ALL other lines — comments, blank lines, and
 * unrelated blocks — byte-for-byte. The load-bearing property the test asserts:
 * a hand-edited file's comments survive the merge.
 */
export function mergeTomlMcpServer(
  existing: string | null | undefined,
  name: string,
  block: string,
): string {
  assertSafeMergeName(name)
  const header = `[mcp_servers.${name}]`
  const src = existing ?? ''
  if (!src.trim()) return block.endsWith('\n') ? block : `${block}\n`

  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.trim() === header)
  if (start === -1) {
    // Append a fresh block, separated by a blank line from prior content.
    const sep = src.endsWith('\n') ? '' : '\n'
    return `${src}${sep}\n${block}\n`
  }
  // The block runs until the next top-level `[` header or EOF.
  let end = start + 1
  while (end < lines.length && !lines[end]!.trimStart().startsWith('[')) end++
  const blockLines = block.split('\n')
  const merged = [...lines.slice(0, start), ...blockLines, ...lines.slice(end)]
  return merged.join('\n')
}

export interface TranscodeResult {
  format: 'json' | 'toml'
  /** JSON entry (json format) — merge via mergeJsonMcpServers. */
  entry?: Record<string, unknown>
  /** TOML block (toml format) — merge via mergeTomlMcpServer. */
  block?: string
}

/** Dialect the canonical spec for a runtime; the caller merges into the file. */
export function transcodeServer(dialect: McpDialect, spec: CanonicalMcpServer): TranscodeResult {
  if (dialect === 'codex') return { format: 'toml', block: toCodexTomlBlock(spec) }
  return { format: 'json', entry: toJsonEntry(spec) }
}
