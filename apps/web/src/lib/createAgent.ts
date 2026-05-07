/**
 * apps/web/src/lib/createAgent.ts
 *
 * Wraps the two-step agent creation flow the gateway requires:
 *   1. config.get → derive workspace path from the config file location
 *   2. agents.create({ name, workspace }) → agentId
 *   3. agents.files.set × N for SOUL.md / IDENTITY.md / TOOLS.md
 *
 * Call resolveWorkspaceDir() once per team deployment, then createAgent()
 * per agent to avoid redundant config.get RPCs.
 */

import type { GatewayClient } from '@clawboo/gateway-client'
import { buildClawbooHelpDoc, buildTeamAgentsMd, type TeammateDef } from './teamProtocol'

// ─── Path utilities (no Node.js path module — runs in the browser) ──────────

function dirnameLike(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx < 0 ? '' : p.slice(0, idx)
}

function joinPathLike(dir: string, leaf: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  const d = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir
  return `${d}${sep}${leaf}`
}

function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'agent'
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Build a simple TOOLS.md from a list of skill names (legacy TeamProfile format). */
export function buildToolsMd(skills: string[]): string {
  if (!skills.length) return '# TOOLS\n'
  return `# TOOLS\n\n## Skills\n${skills.map((s) => `- ${s}`).join('\n')}\n`
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch the gateway config and derive the state directory path.
 * Call this once before deploying a team.
 */
export async function resolveWorkspaceDir(client: GatewayClient): Promise<string> {
  const snapshot = await client.config.get()
  const configPath = typeof snapshot.path === 'string' ? snapshot.path.trim() : ''
  if (!configPath) throw new Error('Gateway did not return a config path.')
  const stateDir = dirnameLike(configPath)
  if (!stateDir) throw new Error(`Config path "${configPath}" has no directory component.`)
  return stateDir
}

export type AgentFiles = {
  soul?: string
  identity?: string
  tools?: string
  agents?: string
  /**
   * `CLAWBOO.md` — workspace-resident operating reference. Read by agents
   * via `cat ~/CLAWBOO.md` when they need to look up the team protocol
   * (workspace isolation, [Team Update] semantics, orchestration loop,
   * etc.). See `buildClawbooHelpDoc` in `lib/teamProtocol.ts`.
   */
  clawboo?: string
}

/**
 * Create one agent and optionally write its personality files.
 * Returns the new agent's ID.
 */
export async function createAgent(
  client: GatewayClient,
  name: string,
  workspaceDir: string,
  files?: AgentFiles,
): Promise<string> {
  const workspace = joinPathLike(workspaceDir, `workspace-${slugifyName(name)}`)
  const result = await client.agents.create({ name, workspace })
  const agentId = result.agentId.trim()
  if (!agentId) throw new Error('Gateway did not return an agentId for the created agent.')

  if (files?.soul) await client.agents.files.set(agentId, 'SOUL.md', files.soul)
  if (files?.identity) await client.agents.files.set(agentId, 'IDENTITY.md', files.identity)
  if (files?.tools) await client.agents.files.set(agentId, 'TOOLS.md', files.tools)
  if (files?.agents) await client.agents.files.set(agentId, 'AGENTS.md', files.agents)
  if (files?.clawboo) await client.agents.files.set(agentId, 'CLAWBOO.md', files.clawboo)

  return agentId
}

/**
 * Re-generate an agent's `AGENTS.md` AND `CLAWBOO.md` from scratch:
 *
 *   - `AGENTS.md`: extracts the routing rules from the current content and
 *     re-wraps them with the latest team protocol (roster, workspace
 *     warning, delegation syntax, anti-sub-agent guardrail, pointer to
 *     `CLAWBOO.md`).
 *   - `CLAWBOO.md`: regenerated unconditionally so agents pick up any
 *     protocol updates the next time they `cat` it.
 *
 * Used by the "Refresh Protocol" UX in `TeamContextMenu` to upgrade existing
 * agents whose `AGENTS.md` was written before a protocol revision.
 *
 * Kept under the `refreshTeamAgentsMd` name for backwards-compatibility with
 * existing callers; the function now refreshes both files.
 */
export async function refreshTeamAgentsMd(params: {
  client: GatewayClient
  agentId: string
  agentName: string
  teamName: string
  teammates: TeammateDef[]
}): Promise<void> {
  const { client, agentId, agentName, teamName, teammates } = params
  const content = await client.agents.files.read(agentId, 'AGENTS.md')
  let routingRules = content ?? ''

  // If enhanced format (has "### Routing Rules"), extract only the rules section
  const headerIdx = routingRules.indexOf('### Routing Rules')
  if (headerIdx !== -1) {
    routingRules = routingRules.slice(headerIdx + '### Routing Rules'.length).trim()
  }

  const enhanced = buildTeamAgentsMd({
    agentName,
    teamName,
    teammates,
    routingRules,
  })

  // CLAWBOO.md is regenerated wholesale — there's no per-team customization
  // in it (every team gets the same operating reference, just with the team's
  // own teammate list inlined for path discoverability).
  const clawboo = buildClawbooHelpDoc({ agentName, teamName, teammates })

  await client.agents.files.set(agentId, 'AGENTS.md', enhanced)
  await client.agents.files.set(agentId, 'CLAWBOO.md', clawboo)
}
