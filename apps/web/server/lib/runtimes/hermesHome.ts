// Provisioning for a Hermes home dir. With a STABLE per-identity home the
// runtime's native state — sessions, MEMORY.md, state.db (FTS5 recall), and
// self-created skills/ — persists and COMPOUNDS across runs, which is the whole
// point of driving Hermes as a preserved runtime (the preserved-runtime adapter
// model: drive one-shot, never lobotomize).
//
// INVARIANTS:
// - clawboo NEVER writes into the user's real ~/.hermes (read/copy-from only).
// - Inside a clawboo-owned home, clawboo writes only `config.yaml` and
//   `auth.json`. `config.yaml` is seeded ONCE from the user's config (never
//   overwritten, never written back) and carries one clawboo-owned, marked
//   `mcp_servers` block that is rewritten every run. `auth.json` is a
//   FRESHNESS-GATED seed copy (the ChatGPT-subscription OAuth, see
//   seedHermesAuth). Everything else in the home belongs to Hermes itself.
// - Hermes loads runtime MCP servers only from `mcp_servers` in
//   `$HERMES_HOME/config.yaml` (hermes 0.15.2 `tools/mcp_tool.py`
//   `_load_mcp_config`); a `mcp.json` is read only inside plugin bundles.

import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { hasUsableHermesCodexAuth, userHermesAuthPath } from './hermesAuth'

export function userHermesConfigPath(): string {
  return path.join(os.homedir(), '.hermes', 'config.yaml')
}

export interface ProvisionedHermesHome {
  home: string
  /** True when this provision created the dir. A fresh home cannot hold any
   *  prior session, so `--resume` is skipped for this run. */
  created: boolean
  /** True when config.yaml was seed-copied from the user's ~/.hermes this run. */
  seededConfig: boolean
  /** True when auth.json was seed-copied from the user's ~/.hermes this run. */
  seededAuth: boolean
  /** True when the run's clawboo MCP servers are in the home's config.yaml.
   *  False when there are none to attach, or the config declares `mcp_servers`
   *  as a non-empty flow mapping (`mcp_servers: {a: ...}`), which a line edit
   *  cannot extend safely. */
  mcpAttached?: boolean
}

/** The HTTP MCP servers clawboo attaches to a Hermes run, by server name. */
export type HermesMcpServers = Record<string, { url: string }>

/** Markers around the clawboo-owned part of a managed home's config.yaml. */
export const CLAWBOO_MCP_BEGIN =
  '# >>> clawboo mcp_servers (managed by clawboo, rewritten every run) >>>'
export const CLAWBOO_MCP_END = '# <<< clawboo mcp_servers <<<'

/** clawboo's servers are named `clawboo-<server>`. A config Hermes re-saved
 *  (`hermes mcp add`, `hermes config set`) loses its comments, so the entries
 *  are recognized by name as well as by the markers. */
const CLAWBOO_SERVER_KEY_RE = /^(\s*)(['"]?)clawboo-[A-Za-z0-9_-]*\2\s*:/
const MCP_SERVERS_KEY_RE = /^mcp_servers\s*:/
/** A line that starts a new top-level key (column 0, not a comment, not a
 *  compact sequence item). */
const TOP_LEVEL_RE = /^[^\s#-]/

const indentOf = (line: string): number => line.length - line.trimStart().length
const isBlankOrComment = (line: string): boolean => {
  const t = line.trim()
  return t === '' || t.startsWith('#')
}

/** The line range of the top-level `mcp_servers` block's children. */
function mcpServersBlock(lines: string[]): { key: number; end: number } | null {
  const key = lines.findIndex((l) => MCP_SERVERS_KEY_RE.test(l))
  if (key === -1) return null
  let end = key + 1
  while (end < lines.length && !TOP_LEVEL_RE.test(lines[end] ?? '')) end++
  return { key, end }
}

/** The indent of the block's first child entry, or null for an empty block. */
function childIndent(lines: string[], block: { key: number; end: number }): number | null {
  for (let i = block.key + 1; i < block.end; i++) {
    const line = lines[i] ?? ''
    if (!isBlankOrComment(line)) return indentOf(line)
  }
  return null
}

/** Remove the marked block, then any `clawboo-*` entry left without markers. */
function stripClawbooMcp(lines: string[]): string[] {
  let out = [...lines]
  const begin = out.findIndex((l) => l.trim() === CLAWBOO_MCP_BEGIN)
  if (begin !== -1) {
    const end = out.findIndex((l, i) => i > begin && l.trim() === CLAWBOO_MCP_END)
    out.splice(begin, end === -1 ? 1 : end - begin + 1)
  }
  const block = mcpServersBlock(out)
  if (!block) return out
  const indent = childIndent(out, block)
  if (indent === null) return out
  const kept = out.slice(0, block.key + 1)
  for (let i = block.key + 1; i < block.end; i++) {
    const line = out[i] ?? ''
    if (indentOf(line) === indent && CLAWBOO_SERVER_KEY_RE.test(line)) {
      // Skip the entry and everything nested under it.
      while (i + 1 < block.end) {
        const next = out[i + 1] ?? ''
        if (next.trim() !== '' && indentOf(next) <= indent) break
        i++
      }
      continue
    }
    kept.push(line)
  }
  out = [...kept, ...out.slice(block.end)]
  return out
}

function renderEntries(servers: [string, { url: string }][], indent: string): string[] {
  const lines = [`${indent}${CLAWBOO_MCP_BEGIN}`]
  for (const [name, server] of servers) {
    // A JSON string is a valid YAML double-quoted scalar, so the URL's `?`, `&`
    // and `=` need no further escaping.
    lines.push(`${indent}${name}:`, `${indent}  url: ${JSON.stringify(server.url)}`)
  }
  lines.push(`${indent}${CLAWBOO_MCP_END}`)
  return lines
}

/**
 * Rewrite the clawboo-owned part of a Hermes `config.yaml` body, leaving the
 * rest as written. The previous clawboo block is removed first; then, when
 * `servers` is non-empty, the servers are added inside the user's own
 * top-level `mcp_servers` mapping (so its servers keep working) or, without
 * one, as a new marked `mcp_servers` block at the end. Pure; exported for tests.
 */
export function mergeClawbooMcpServers(
  body: string,
  servers: HermesMcpServers | null,
): { body: string; attached: boolean } {
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = stripClawbooMcp(body === '' ? [] : body.split(/\r?\n/))
  const entries = Object.entries(servers ?? {})
  const finish = (out: string[], attached: boolean) => {
    while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop()
    return { body: out.length > 0 ? out.join(eol) + eol : '', attached }
  }
  if (entries.length === 0) return finish(lines, false)

  const block = mcpServersBlock(lines)
  if (!block) {
    const out = [...lines]
    while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop()
    if (out.length > 0) out.push('')
    out.push(CLAWBOO_MCP_BEGIN, 'mcp_servers:', ...renderEntries(entries, '  ').slice(1))
    return finish(out, true)
  }
  const keyLine = lines[block.key] ?? ''
  const value = keyLine
    .replace(MCP_SERVERS_KEY_RE, '')
    .replace(/(^|\s)#.*$/, '')
    .trim()
  const existing = value === '' ? childIndent(lines, block) : null
  // A flow mapping with entries, or children at column 0 (a sequence, which
  // Hermes rejects anyway), has no line-level place for more entries.
  if ((value !== '' && value !== '{}' && value !== 'null' && value !== '~') || existing === 0) {
    return finish(lines, false)
  }
  const indent = ' '.repeat(existing ?? 2)
  const out = [
    ...lines.slice(0, block.key),
    value === '' ? keyLine : 'mcp_servers:',
    ...renderEntries(entries, indent),
    ...lines.slice(block.key + 1),
  ]
  return finish(out, true)
}

/** The server names under a `config.yaml` body's top-level `mcp_servers`. */
export function listHermesMcpServerNames(body: string): string[] {
  const lines = body.split(/\r?\n/)
  const block = mcpServersBlock(lines)
  if (!block) return []
  const indent = childIndent(lines, block)
  if (indent === null) return []
  const names: string[] = []
  for (let i = block.key + 1; i < block.end; i++) {
    const line = lines[i] ?? ''
    if (isBlankOrComment(line) || indentOf(line) !== indent) continue
    const m = /^\s*(['"]?)([^'":#]+?)\1\s*:/.exec(line)
    if (m?.[2]) names.push(m[2].trim())
  }
  return names
}

/**
 * Seed the user's `hermes login` auth store into the managed home. Copy-only —
 * NEVER writes back to `~/.hermes`. Mirrors `seedCodexAuth` (codexDriver.ts):
 * for a persistent managed home this is a FRESHNESS DECISION — hermes refreshes
 * (and on terminal failure quarantines) tokens inside the managed home's own
 * auth.json, so the user's copy only replaces it when the user's file is NEWER
 * (a re-login) or the managed one is missing/unusable. A blind re-copy would
 * replay an already-consumed refresh token. Rotation hazard, documented: every
 * home seeded from one login is another rotator on that grant family — the
 * surfaced auth path is a FRESH `hermes auth add openai-codex` (never
 * the codex-CLI import) precisely to keep lineages narrow. Best-effort: never
 * throws. Exported for tests.
 */
export async function seedHermesAuth(home: string): Promise<boolean> {
  try {
    const src = userHermesAuthPath()
    if (!existsSync(src)) return false
    const dst = path.join(home, 'auth.json')
    if (existsSync(dst) && hasUsableHermesCodexAuth(dst)) {
      const [srcStat, dstStat] = await Promise.all([stat(src), stat(dst)])
      if (srcStat.mtimeMs <= dstStat.mtimeMs) return false // managed token is as fresh or fresher
    }
    await copyFile(src, dst)
    await chmod(dst, 0o600).catch(() => undefined) // owner-only (no-op on Windows)
    return true
  } catch {
    return false // best-effort — auth seeding is not fatal to provisioning
  }
}

export async function provisionHermesHome(
  home: string,
  opts: { mcpServers?: HermesMcpServers | null } = {},
): Promise<ProvisionedHermesHome> {
  const created = !existsSync(home)
  await mkdir(home, { recursive: true, mode: 0o700 })

  // Seed config.yaml from the user's real ~/.hermes while the home's copy holds
  // nothing but clawboo's own block (so a user who configures Hermes AFTER the
  // first provision is picked up on the next run). NEVER overwrite a seeded
  // copy, NEVER write back. `.env` is NOT seeded: provider keys ride the
  // spawned process env (the credential vault is the source of truth) and
  // copying credentials would multiply secret surfaces on disk.
  const configPath = path.join(home, 'config.yaml')
  const onDisk = await readFile(configPath, 'utf8').catch(() => null)
  let base = onDisk ?? ''
  let seededConfig = false
  if (mergeClawbooMcpServers(base, null).body === '' && existsSync(userHermesConfigPath())) {
    try {
      base = await readFile(userHermesConfigPath(), 'utf8')
      seededConfig = true
    } catch {
      // Seeding is best-effort; Hermes falls back to its built-in defaults.
    }
  }

  // The clawboo block is refreshed every run (the server port can change across
  // restarts) and removed when there is no MCP base URL, so a stale attach
  // config never lingers.
  const merged = mergeClawbooMcpServers(base, opts.mcpServers ?? null)
  if (merged.body === '') {
    if (onDisk !== null) await rm(configPath, { force: true })
  } else if (merged.body !== onDisk) {
    // Write-then-rename, so a crash mid-write never truncates the seeded config.
    const tmp = `${configPath}.clawboo-${process.pid}-${randomUUID()}.tmp`
    try {
      await writeFile(tmp, merged.body, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, configPath)
    } catch (err) {
      // The temp copy holds the attach URLs: never leave it behind.
      await rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
    await chmod(configPath, 0o600).catch(() => undefined) // owner-only (no-op on Windows)
  }
  // Earlier versions wrote the servers to `mcp.json`, which Hermes never reads.
  await rm(path.join(home, 'mcp.json'), { force: true })

  // Seed the ChatGPT-subscription auth (freshness-gated; see seedHermesAuth).
  // A managed home outside ~/.hermes is its OWN hermes root (no global-auth
  // fallback), so without this copy the user's `hermes login` is invisible to
  // spawned runs and an `openai-codex` pick would fail auth.
  const seededAuth = await seedHermesAuth(home)

  return { home, created, seededConfig, seededAuth, mcpAttached: merged.attached }
}

/**
 * Read the configured provider from `<home>/config.yaml`. Per the Hermes CLI,
 * the persistent provider lives under the `model:` block's `provider:` key — a
 * block-scoped line scan (no YAML dep) so the top-level `providers:` map (the
 * user-defined provider definitions) can never false-positive.
 */
export async function detectProvider(home: string): Promise<string | null> {
  let body: string
  try {
    body = await readFile(path.join(home, 'config.yaml'), 'utf8')
  } catch {
    return null
  }
  let inModelBlock = false
  for (const line of body.split('\n')) {
    if (/^\S/.test(line)) {
      inModelBlock = /^model\s*:/.test(line)
      continue
    }
    if (!inModelBlock) continue
    const m = /^\s+provider\s*:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*(?:#.*)?$/.exec(line)
    if (m?.[1]) return m[1]
  }
  return null
}
