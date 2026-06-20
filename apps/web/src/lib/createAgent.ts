/**
 * apps/web/src/lib/createAgent.ts
 *
 * Thin browser wrappers over the agent registry-of-record (AgentSource). Agent
 * creation + file I/O happen SERVER-SIDE now (the server resolves the workspace
 * via its own Gateway connection); these helpers just shape the request + map the
 * AgentFiles bag into the filename-keyed payload the REST surface expects.
 */

import { createAgentRecord, readAgentFile, writeAgentFile } from '@/lib/agentSourceClient'
import { buildClawbooHelpDoc, buildTeamAgentsMd, type TeammateDef } from './teamProtocol'

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Build a simple TOOLS.md from a list of skill names (legacy TeamProfile format). */
export function buildToolsMd(skills: string[]): string {
  if (!skills.length) return '# TOOLS\n'
  return `# TOOLS\n\n## Skills\n${skills.map((s) => `- ${s}`).join('\n')}\n`
}

export type AgentFiles = {
  soul?: string
  identity?: string
  tools?: string
  agents?: string
  /**
   * `CLAWBOO.md` — workspace-resident operating reference. Read by agents
   * via `cat ~/CLAWBOO.md` when they need the team protocol. Best-effort:
   * older Gateways reject non-allowlisted filenames (the server swallows that).
   */
  clawboo?: string
}

function toFilePayload(files?: AgentFiles): Record<string, string> | undefined {
  if (!files) return undefined
  const out: Record<string, string> = {}
  if (files.soul) out['SOUL.md'] = files.soul
  if (files.identity) out['IDENTITY.md'] = files.identity
  if (files.tools) out['TOOLS.md'] = files.tools
  if (files.agents) out['AGENTS.md'] = files.agents
  if (files.clawboo) out['CLAWBOO.md'] = files.clawboo
  return Object.keys(out).length > 0 ? out : undefined
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create one agent (server-side: Gateway create + workspace resolution + file
 * writes + SQLite mirror) and return the new agent's id.
 */
export async function createAgent(name: string, files?: AgentFiles): Promise<string> {
  const record = await createAgentRecord({ name, files: toFilePayload(files) })
  const agentId = record.id.trim()
  if (!agentId) throw new Error('AgentSource did not return an id for the created agent.')
  return agentId
}

/**
 * Re-generate an agent's `AGENTS.md` AND `CLAWBOO.md` from scratch (the "Refresh
 * Protocol" UX): extract the routing rules from the current AGENTS.md and re-wrap
 * them with the latest team protocol; regenerate CLAWBOO.md wholesale. Reads/writes
 * route through the AgentSource (server delegates to the Gateway).
 */
export async function refreshTeamAgentsMd(params: {
  agentId: string
  agentName: string
  teamName: string
  teammates: TeammateDef[]
  /** Boo Zero's name — the universal team leader (omitted in tests). */
  universalLeaderName?: string | null
  /** Team-internal lead (CTO, Team Lead, etc.), if any. */
  teamInternalLeadName?: string | null
}): Promise<void> {
  const { agentId, agentName, teamName, teammates, universalLeaderName, teamInternalLeadName } =
    params
  let routingRules = ''
  try {
    routingRules = await readAgentFile(agentId, 'AGENTS.md')
  } catch {
    routingRules = ''
  }

  // If enhanced format (has "### Routing Rules"), extract only the rules section.
  const headerIdx = routingRules.indexOf('### Routing Rules')
  if (headerIdx !== -1) {
    routingRules = routingRules.slice(headerIdx + '### Routing Rules'.length).trim()
  }

  const enhanced = buildTeamAgentsMd({
    agentName,
    teamName,
    teammates,
    routingRules,
    universalLeaderName,
    teamInternalLeadName,
  })
  const clawboo = buildClawbooHelpDoc({ agentName, teamName, teammates, universalLeaderName })

  await writeAgentFile(agentId, 'AGENTS.md', enhanced)
  // CLAWBOO.md is best-effort — Gateways that reject the filename shouldn't
  // poison "Refresh Protocol".
  try {
    await writeAgentFile(agentId, 'CLAWBOO.md', clawboo)
  } catch {
    // Silent fallback — preamble injection delivers the operating reference.
  }
}
