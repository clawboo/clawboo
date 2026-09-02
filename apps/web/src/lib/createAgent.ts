/**
 * apps/web/src/lib/createAgent.ts
 *
 * Thin browser wrappers over the agent registry-of-record (AgentSource). Agent
 * creation + file I/O happen SERVER-SIDE now (the server resolves the workspace
 * via its own Gateway connection); these helpers just shape the request + map the
 * AgentFiles bag into the filename-keyed payload the REST surface expects.
 */

import { createAgentRecord, readAgentFile, writeAgentFile } from '@clawboo/control-client'
import { buildTeamAgentsMd, type TeammateDef } from './teamProtocol'

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
 * Create one agent (server-side: the chosen AgentSource resolves the workspace,
 * writes the files, and mirrors SQLite) and return the new agent's id.
 *
 * `sourceId` selects the runtime that owns the record — omit for the server
 * default (`openclaw`), `'clawboo-native'` for a native agent, or a coding
 * runtime id (`'claude-code'`/`'codex'`/`'hermes'`). `execConfig` is the
 * source-specific config carrier (native: the AgentConfig — systemPrompt, tools,
 * modelTier; coding runtimes ignore it). Both trail the original 2-arg signature
 * so existing positional callers are unaffected.
 */
export async function createAgent(
  name: string,
  files?: AgentFiles,
  sourceId?: string,
  execConfig?: unknown,
): Promise<string> {
  const record = await createAgentRecord({
    name,
    files: toFilePayload(files),
    ...(sourceId ? { sourceId } : {}),
    ...(execConfig !== undefined ? { execConfig } : {}),
  })
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
  await writeAgentFile(agentId, 'AGENTS.md', enhanced)
  // No CLAWBOO.md write here. It is not in AGENT_FILE_NAMES, so the PUT was
  // refused with 400 by clawboo's own route before reaching any Gateway: the
  // call never once succeeded on any runtime, and its catch made that look
  // like an occasional Gateway quirk. The operating reference reaches the
  // agent through runtime preamble injection, and the OpenClaw create path
  // writes the file via the Gateway client directly.
}
