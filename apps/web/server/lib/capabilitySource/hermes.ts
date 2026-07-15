// hermes CapabilitySource — read-only OBSERVE of each Hermes per-identity home
// under `~/.clawboo/runtimes/hermes/<agentId>/`. Hermes owns its native
// self-model; the invariant (hermesSkills.ts) is that clawboo NEVER writes a
// Hermes skills dir — so its SKILL.md skills are surfaced `observe-only` rather
// than the default `external-write` manageability (the runtime keeps its native
// substrate). The mcp.json is clawboo-owned
// but REGENERATED every run (provisionHermesHome overwrites it), so its
// connectors are the clawboo attach spine — also `observe-only`, not a durable
// user surface. Build-ins roll up to one observe-only record. write() → unsupported.

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import {
  unsupported,
  type CapabilityReadResult,
  type CapabilityRecord,
  type CapabilitySource,
  type CapabilityWriteAction,
} from '@clawboo/capability-registry'
import { agents, createDb, type ClawbooDb } from '@clawboo/db'

import { listNativeSkills } from '../runtimes/hermesSkills'
import { buildRecord, builtinRollup, degradedStatus, okStatus } from './helpers'

function hermesHomesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveClawbooDir(env), 'runtimes', 'hermes')
}

/** Minimal `--- key: value ---` frontmatter parse (no YAML dep — the repo has none). */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (kv?.[1] && kv[2]) out[kv[1].toLowerCase()] = kv[2].replace(/^['"]|['"]$/g, '')
  }
  const result: { name?: string; description?: string } = {}
  if (out['name']) result.name = out['name']
  if (out['description']) result.description = out['description']
  return result
}

/** Read a skill's SKILL.md frontmatter (dir or flat-file layout). Best-effort. */
async function readSkillMeta(
  home: string,
  skillName: string,
): Promise<{ name?: string; description?: string }> {
  for (const rel of [
    path.join('skills', skillName, 'SKILL.md'),
    path.join('skills', `${skillName}.md`),
  ]) {
    try {
      return parseFrontmatter(await readFile(path.join(home, rel), 'utf8'))
    } catch {
      /* try the next layout */
    }
  }
  return {}
}

interface McpConnector {
  name: string
}

async function readMcpConnectors(home: string): Promise<McpConnector[]> {
  try {
    const raw = await readFile(path.join(home, 'mcp.json'), 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    return Object.keys(parsed.mcpServers ?? {}).map((name) => ({ name }))
  } catch {
    return []
  }
}

export class HermesCapabilitySource implements CapabilitySource {
  readonly id = 'hermes' as const

  constructor(private readonly deps: { getDbPath?: () => string; env?: NodeJS.ProcessEnv } = {}) {}

  /** Live hermes agent ids (hermes-sourced, not archived) — the set a home dir
   *  must belong to. `null` when no db is wired (unit tests) or the db is
   *  unreadable → skip the filter (surface all homes, the legacy behaviour). */
  private liveHermesAgentIds(): Set<string> | null {
    if (!this.deps.getDbPath) return null
    try {
      const db: ClawbooDb = createDb(this.deps.getDbPath())
      const ids = new Set<string>()
      for (const a of db.select().from(agents).all()) {
        if (a.archivedAt != null) continue
        if (a.sourceId === 'hermes' || a.runtime === 'hermes') ids.add(a.id)
      }
      return ids
    } catch {
      return null
    }
  }

  async read(): Promise<CapabilityReadResult> {
    const records: CapabilityRecord[] = []
    const root = hermesHomesRoot(this.deps.env ?? process.env)

    let homes: string[]
    try {
      const entries = await readdir(root, { withFileTypes: true })
      homes = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    } catch {
      // No Hermes homes yet (no runs) — not an error; report empty + ok.
      return { records: [builtinRollup('hermes', 'hermes', 'Hermes')], status: okStatus('hermes') }
    }

    // Scope to LIVE hermes agents so a DELETED agent's leftover home dir under
    // ~/.clawboo/runtimes/hermes/<id>/ doesn't surface as a ghost capability
    // record for a non-existent agent (the reported orphan). Null = no db wired
    // → keep all homes (unchanged behaviour).
    const liveIds = this.liveHermesAgentIds()
    const scopedHomes = liveIds ? homes.filter((id) => liveIds.has(id)) : homes

    try {
      for (const agentId of scopedHomes) {
        const home = path.join(root, agentId)

        const skillNames = await listNativeSkills(home)
        for (const skillName of skillNames) {
          const meta = await readSkillMeta(home, skillName)
          records.push(
            buildRecord({
              sourceId: 'hermes',
              runtime: 'hermes',
              scope: 'agent',
              agentId,
              kind: 'skill',
              sourceKey: skillName,
              origin: 'filesystem-skill-md',
              manageability: 'observe-only', // clawboo never writes a Hermes skills dir
              name: meta.name ?? skillName,
              description: meta.description ?? 'Hermes native skill',
              available: true,
              status: 'ready',
            }),
          )
        }

        for (const conn of await readMcpConnectors(home)) {
          records.push(
            buildRecord({
              sourceId: 'hermes',
              runtime: 'hermes',
              scope: 'agent',
              agentId,
              kind: 'connector',
              sourceKey: `mcp:${conn.name}`,
              origin: 'mcp-connector',
              manageability: 'observe-only', // mcp.json is regenerated every run
              name: conn.name,
              description: 'Attached MCP server',
              available: true,
              status: 'ready',
            }),
          )
        }
      }
    } catch (err) {
      return {
        records,
        status: degradedStatus('hermes', err instanceof Error ? err.message : String(err)),
      }
    }

    records.push(builtinRollup('hermes', 'hermes', 'Hermes'))
    return { records, status: okStatus('hermes') }
  }

  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    // Every Hermes capability is observe-only (native self-model; clawboo never
    // writes its skills dir, and mcp.json is regenerated each run).
    unsupported('hermes', action.kind)
  }
}
