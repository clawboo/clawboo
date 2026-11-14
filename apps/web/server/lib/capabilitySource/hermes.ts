// hermes CapabilitySource — read-only OBSERVE of each Hermes per-identity home
// under `~/.clawboo/runtimes/hermes/<agentId>/` (with agents on their own OS user,
// under that user's runtime homes instead). Hermes owns its native
// self-model; the invariant (hermesSkills.ts) is that clawboo NEVER writes a
// Hermes skills dir — so its SKILL.md skills are surfaced `observe-only` rather
// than the default `external-write` manageability (the runtime keeps its native
// substrate). Connectors are the `mcp_servers` the home's config.yaml declares:
// clawboo's own entries are REGENERATED every run (provisionHermesHome rewrites
// its marked block), so they are the clawboo attach spine, and any others came
// with the seeded user config. Both are `observe-only`, not a durable clawboo
// surface. Built-ins roll up to one observe-only record. write() is unsupported.

import path from 'node:path'

import {
  unsupported,
  type CapabilityReadResult,
  type CapabilityRecord,
  type CapabilitySource,
  type CapabilityWriteAction,
} from '@clawboo/capability-registry'
import { agents, type ClawbooDb } from '@clawboo/db'

import { agentList, agentReadFile } from '../agentUser/agentFs'
import { listHermesMcpServerNames } from '../runtimes/hermesHome'
import { listNativeSkills } from '../runtimes/hermesSkills'
import { runtimeHomesRoot } from '../runtimes/identityHome'
import { buildRecord, builtinRollup, degradedStatus, okStatus } from './helpers'

/** Where the Hermes homes are: the runs' own root, which is under the agent
 *  user's home when agents run as their own OS user. The homes are agent space,
 *  so everything below is read through the agent-space file verbs. */
function hermesHomesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeHomesRoot(env), 'hermes')
}

/** A file in a Hermes home as text, or null when it is not there. */
async function readHomeFile(file: string): Promise<string | null> {
  const buf = await agentReadFile(file)
  return buf === null ? null : buf.toString('utf8')
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
      const text = await readHomeFile(path.join(home, rel))
      if (text !== null) return parseFrontmatter(text)
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
    const raw = await readHomeFile(path.join(home, 'config.yaml'))
    return raw === null ? [] : listHermesMcpServerNames(raw).map((name) => ({ name }))
  } catch {
    return []
  }
}

export class HermesCapabilitySource implements CapabilitySource {
  readonly id = 'hermes' as const

  constructor(private readonly deps: { getDb?: () => ClawbooDb; env?: NodeJS.ProcessEnv } = {}) {}

  /** Live hermes agent ids (hermes-sourced, not archived) — the set a home dir
   *  must belong to. `null` when no db is wired (unit tests) or the db is
   *  unreadable → skip the filter (surface all homes, the legacy behaviour). */
  private liveHermesAgentIds(): Set<string> | null {
    if (!this.deps.getDb) return null
    try {
      const db: ClawbooDb = this.deps.getDb()
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
    let root: string
    let homes: string[]
    try {
      root = hermesHomesRoot(this.deps.env ?? process.env)
      const { entries } = await agentList(root)
      homes = entries.filter((e) => e.type === 'dir' && !e.name.startsWith('.')).map((e) => e.name)
    } catch {
      // No Hermes homes yet (no runs), or with agents on their own OS user no
      // agent host to read them through: not an error; report empty + ok.
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
              manageability: 'observe-only', // config.yaml mcp_servers, rewritten every run
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
    // writes its skills dir, and its MCP block is rewritten each run).
    unsupported('hermes', action.kind)
  }
}
