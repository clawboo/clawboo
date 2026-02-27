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

  return agentId
}
