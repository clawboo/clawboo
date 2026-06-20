// ─── Memory MCP server ───────────────────────────────────────────────────────
// memory_save / memory_search / memory_browse over the shared SqliteMemoryStore.
// Flat schema: scope as scopeTeamId/scopeAgentId; procedureName switches a save
// from a fact to a procedure.

import {
  scrubSecrets,
  SqliteMemoryStore,
  type ClawbooDb,
  type EmbeddingProvider,
  type MemoryScope,
  type SearchMode,
} from '@clawboo/db'
import { z } from 'zod'

import { buildServer, jsonResult, textResult, type Server, type ToolDef } from '../shared'

const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
function scopeOf(args: Record<string, unknown>): MemoryScope {
  return { teamId: optStr(args['scopeTeamId']), agentId: optStr(args['scopeAgentId']) }
}

/** True when non-empty content reduces to nothing but redaction sentinels after
 *  scrubbing (the store scrubs on write — so an all-secret fact would store as a
 *  useless `[REDACTED]`). Empty content is left to the store's normal path. */
function isAllRedacted(content: string): boolean {
  if (content.trim().length === 0) return false
  const scrubbed = String(scrubSecrets(content))
  return scrubbed.replace(/\[REDACTED\]/g, '').trim().length === 0
}

export interface MemoryServerOptions {
  /**
   * When set, the run's scope is AUTHORITATIVE — the model can neither widen its
   * visibility nor mis-tag a save:
   *  - SAVE tags the fact with the bound TEAM only (agentId left null = shared
   *    across all teammates, so any runtime's agent on the team recalls it).
   *  - SEARCH / BROWSE filter by the full bound scope (team + agent inclusive +
   *    global), excluding other teams / other agents' private facts.
   * Unset ⇒ the model's scope args are used (the stdio bin / unbound default).
   */
  boundScope?: MemoryScope
}

export function createMemoryServer(
  db: ClawbooDb,
  embed?: EmbeddingProvider | null,
  opts: MemoryServerOptions = {},
): Server {
  const store = new SqliteMemoryStore(db, embed)
  const bound = opts.boundScope

  // Auto-saved team facts are team-shared (drop agentId) so a teammate on ANY
  // runtime recalls them — agent-scoping a save would defeat the shared tier.
  const saveScope = (args: Record<string, unknown>): MemoryScope =>
    bound ? { teamId: bound.teamId ?? null, tenantId: bound.tenantId ?? null } : scopeOf(args)
  // Reads see team-shared + global + this-agent-private; never another team's. A
  // bound run with NO team (teamId null) reads global-only — '' is the store's
  // global-only sentinel; passing null would skip the team filter (cross-team leak).
  const readScope = (args: Record<string, unknown>): MemoryScope =>
    bound ? { ...bound, teamId: bound.teamId ?? '' } : scopeOf(args)

  const tools: ToolDef[] = [
    {
      name: 'memory_save',
      description:
        'Save a durable fact (title + content) or a versioned procedure (set procedureName). Facts are declarative ("user prefers X"), not instructions.',
      inputSchema: z.object({
        content: z.string(),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
        procedureName: z.string().optional(),
        scopeTeamId: z.string().optional(),
        scopeAgentId: z.string().optional(),
      }),
      handler: async (args) => {
        const content = String(args['content'] ?? '')
        // The store scrubs secrets on write; if the CONTENT reduces ENTIRELY to the
        // redaction sentinel there is nothing worth recalling, so the save is
        // declined — for BOTH a fact and a procedure, BEFORE the branch. This is
        // CONTENT-ONLY BY DESIGN: a fact's recallable value lives in its content,
        // not its title. A fact like {title:'Token', content:'sk-…'} would store
        // only a useless 'Token: [REDACTED]' breadcrumb (the actual token is
        // scrubbed + unrecallable), so it is intentionally refused — the title is
        // not a substitute for recallable content. Do NOT widen this to
        // title+content (the "declines a fact whose content was ENTIRELY a secret"
        // test locks this intent).
        if (isAllRedacted(content)) {
          return textResult('nothing to save: content was entirely redacted secrets', true)
        }
        const procedureName = optStr(args['procedureName'])
        if (procedureName) {
          const proc = await store.saveProcedure({
            name: procedureName,
            content,
            scope: saveScope(args),
          })
          return jsonResult({ saved: 'procedure', procedure: proc })
        }
        const title = optStr(args['title'])
        if (!title)
          return textResult('a fact requires a title (or set procedureName for a procedure)', true)
        const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : undefined
        const fact = await store.saveFact({ title, content, tags, scope: saveScope(args) })
        return jsonResult({ saved: 'fact', fact })
      },
    },
    {
      name: 'memory_search',
      description:
        'Search saved facts. mode: fts (default) | vector | hybrid. Results cite a fact id.',
      inputSchema: z.object({
        query: z.string(),
        mode: z.enum(['fts', 'vector', 'hybrid']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        scopeTeamId: z.string().optional(),
        scopeAgentId: z.string().optional(),
      }),
      handler: async (args) =>
        jsonResult(
          await store.searchMemory(String(args['query'] ?? ''), {
            mode: optStr(args['mode']) as SearchMode | undefined,
            limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
            scope: readScope(args),
          }),
        ),
    },
    {
      name: 'memory_browse',
      description: 'List recent saved facts (scoped).',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        scopeTeamId: z.string().optional(),
        scopeAgentId: z.string().optional(),
      }),
      handler: async (args) =>
        jsonResult(
          await store.browseMemory({
            limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
            scope: readScope(args),
          }),
        ),
    },
  ]

  return buildServer('clawboo-memory', tools)
}
