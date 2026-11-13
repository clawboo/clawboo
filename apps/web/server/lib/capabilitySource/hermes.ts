// hermes CapabilitySource: read-only OBSERVE of each Hermes agent's home: its
// profile in the Hermes gateway's home (`<runtime homes>/hermes/_gateway/
// profiles/<profile>/`), or its old per-identity home `<runtime homes>/hermes/
// <agentId>/` until it first runs through the gateway. The runtime homes are
// `~/.clawboo/runtimes`, or the agent user's own with agents on their own OS
// user. Hermes owns its native
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

import { agentList, agentReadFile, agentStat } from '../agentUser/agentFs'
import { HERMES_GATEWAY_HOME_ID, hermesProfileName } from '../runtimes/hermes/profiles'
import { listHermesMcpServerNames } from '../runtimes/hermesHome'
import { listNativeSkills } from '../runtimes/hermesSkills'
import { runtimeHomesRoot, sanitizeAgentId } from '../runtimes/identityHome'
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
      homes = entries
        .filter(
          (e) => e.type === 'dir' && !e.name.startsWith('.') && e.name !== HERMES_GATEWAY_HOME_ID,
        )
        .map((e) => e.name)
    } catch {
      // No Hermes homes yet (no runs), or with agents on their own OS user no
      // agent host to read them through: not an error; report empty + ok.
      return { records: [builtinRollup('hermes', 'hermes', 'Hermes')], status: okStatus('hermes') }
    }

    // Scoped to LIVE hermes agents, so a deleted agent's leftover home is no
    // ghost record. With a db, every live agent is read even with no old home
    // left: its state lives in its profile in the Hermes gateway's home now.
    // Null = no db wired: the homes on disk.
    const liveIds = this.liveHermesAgentIds()
    const scopedHomes = liveIds ? [...liveIds].sort() : homes

    try {
      for (const agentId of scopedHomes) {
        // The agent's profile in the gateway's home, once its old home moved in.
        const legacy = path.join(root, sanitizeAgentId(agentId))
        const profile = path.join(
          root,
          HERMES_GATEWAY_HOME_ID,
          'profiles',
          hermesProfileName(legacy),
        )
        const home = (await agentStat(profile))?.type === 'dir' ? profile : legacy

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
