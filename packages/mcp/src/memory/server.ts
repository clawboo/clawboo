// ─── Memory MCP server ───────────────────────────────────────────────────────
// memory_save / memory_search / memory_browse over the shared SqliteMemoryStore.
// Flat schema: scope as scopeTeamId/scopeAgentId; procedureName switches a save
// from a fact to a procedure.

import {
  scrubSecrets,
  SqliteMemoryStore,
  type ClawbooDb,
  type EmbeddingProvider,
  type MemoryProvenance,
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

  /**
   * The caller reached us over a transport that CAN carry a verified scope and
   * did NOT — so we know its identity is unproven rather than irrelevant.
   *
   * WHY THIS IS NOT THE SAME AS `boundScope` BEING UNSET. Unset has always meant
   * "the operator ran the stdio bin themselves", where the model's scope args are
   * the only steering available and the operator is the one supplying them. Over
   * HTTP the same absence means something else entirely: an attach URL that
   * carried no signed scope. There the scope args are supplied by the MODEL, and
   * honouring them lets any agent save a fact tagged as another agent's team and
   * read every team's facts back. Distinguishing the two is the whole point of
   * this flag; collapsing them would either re-open that hole or break the bin.
   *
   * Effect: the model's `scopeTeamId`/`scopeAgentId` args are IGNORED. Saves go
   * to the global tier (attributable to nobody, which is honest, rather than to
   * whoever the model named) and reads see the global tier only.
   *
   * This is what `openClawAgentSource` has always CLAIMED happens for OpenClaw
   * agents ("Memory stays global-scoped for OpenClaw"). It was never true: the
   * scope came from the model. This flag makes the code do what that comment says.
   */
  unverifiedCaller?: boolean
  /**
   * Server-authored provenance (runtime/task/session) stamped on saves and
   * outcome reports. Only honored on a BOUND session — unbound sessions record
   * no provenance at all (model-supplied ids are spoofable; worse than null).
   */
  provenance?: MemoryProvenance
}

export function createMemoryServer(
  db: ClawbooDb,
  embed?: EmbeddingProvider | null,
  opts: MemoryServerOptions = {},
): Server {
  const store = new SqliteMemoryStore(db, embed)
  const bound = opts.boundScope
  // Only meaningful when there is no bound scope to prefer; see the field's doc.
  const unverified = opts.unverifiedCaller === true && !bound

  // Auto-saved team facts are team-shared (drop agentId) so a teammate on ANY
  // runtime recalls them — agent-scoping a save would defeat the shared tier.
  // An unverified caller saves GLOBAL: not tagged with a team it cannot prove.
  const saveScope = (args: Record<string, unknown>): MemoryScope =>
    bound
      ? { teamId: bound.teamId ?? null, tenantId: bound.tenantId ?? null }
      : unverified
        ? { teamId: null, agentId: null }
        : scopeOf(args)
  // Reads see team-shared + global + this-agent-private; never another team's. A
  // bound run with NO team (teamId null) reads global-only — '' is the store's
  // global-only sentinel; passing null would skip the team filter (cross-team leak).
  // An unverified caller gets that same global-only sentinel, for the same reason.
  const readScope = (args: Record<string, unknown>): MemoryScope =>
    bound ? { ...bound, teamId: bound.teamId ?? '' } : unverified ? { teamId: '' } : scopeOf(args)
  // Provenance is the ASYMMETRY vs saveScope: a bound save drops agentId from
  // the visibility scope (team-shared recall) but records who saved it here.
  // Unbound AND unverified sessions record NOTHING — spoofable model-supplied
  // ids are worse than null.
  const saveProvenance = (): MemoryProvenance | undefined =>
    bound
      ? { ...opts.provenance, agentId: opts.provenance?.agentId ?? bound.agentId ?? null }
      : undefined

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
            provenance: saveProvenance(),
          })
          return jsonResult({ saved: 'procedure', procedure: proc })
        }
        const title = optStr(args['title'])
        if (!title)
          return textResult('a fact requires a title (or set procedureName for a procedure)', true)
        const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]) : undefined
        const fact = await store.saveFact({
          title,
          content,
          tags,
          scope: saveScope(args),
          provenance: saveProvenance(),
        })
        return jsonResult({ saved: 'fact', fact })
      },
    },
    {
      name: 'memory_search',
      description:
        'Search saved facts. mode: fts (default) | vector | hybrid. Results cite a fact id and may carry a learning status (preferred/tentative/contested/dead_end) from teammate feedback.',
      inputSchema: z.object({
        query: z.string(),
        mode: z.enum(['fts', 'vector', 'hybrid']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        scopeTeamId: z.string().optional(),
        scopeAgentId: z.string().optional(),
      }),
      handler: async (args) => {
        const results = await store.searchMemory(String(args['query'] ?? ''), {
          mode: optStr(args['mode']) as SearchMode | undefined,
          limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
          scope: readScope(args),
        })
        const learning = await store.learningForFacts(
          results.map((r) => r.id),
          Date.now(),
        )
        return jsonResult(results.map((r) => ({ ...r, learning: learning[r.id] ?? null })))
      },
    },
    {
      name: 'memory_browse',
      description: 'List recent saved facts (scoped).',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        scopeTeamId: z.string().optional(),
        scopeAgentId: z.string().optional(),
      }),
      handler: async (args) => {
        const facts = await store.browseMemory({
          limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
          scope: readScope(args),
        })
        const learning = await store.learningForFacts(
          facts.map((f) => f.id),
          Date.now(),
        )
        return jsonResult(facts.map((f) => ({ ...f, learning: learning[f.id] ?? null })))
      },
    },
    {
      name: 'memory_feedback',
      description:
        'Report whether a recalled fact helped. outcome: useful (it was right and helped) | dead_end (it misled or wasted effort) | corrected (it was wrong — supply the correction in note). Cite the fact id from memory_search results or the (id ...) prefix in the auto-memory block; an 8+ char prefix is accepted.',
      inputSchema: z.object({
        factId: z.string(),
        outcome: z.enum(['useful', 'dead_end', 'corrected']),
        note: z.string().optional(),
        scopeTeamId: z.string().optional(),
        scopeAgentId: z.string().optional(),
      }),
      handler: async (args) => {
        // Scope-resolved lookup: an invisible fact and a nonexistent one yield
        // the SAME error — feedback is not a cross-team existence oracle.
        const fact = await store.getFact(String(args['factId'] ?? ''), readScope(args))
        if (!fact)
          return textResult(
            'unknown fact id (or ambiguous prefix) — cite the id from memory_search',
            true,
          )
        if (args['outcome'] === 'corrected' && !optStr(args['note'])?.trim())
          return textResult('corrected requires a note with the correction', true)
        const recorded = await store.recordOutcome({
          factId: fact.id,
          outcome: args['outcome'] as 'useful' | 'dead_end' | 'corrected',
          note: optStr(args['note']) ?? null,
          agentId: bound ? (bound.agentId ?? null) : (optStr(args['scopeAgentId']) ?? null),
          teamId: bound ? (bound.teamId ?? null) : (optStr(args['scopeTeamId']) ?? null),
          taskId: opts.provenance?.taskId ?? null,
          runtime: opts.provenance?.runtime ?? null,
        })
        const learning = await store.learningForFacts([fact.id], Date.now())
        return jsonResult({ recorded, learning: learning[fact.id] ?? null })
      },
    },
  ]

  return buildServer('clawboo-memory', tools)
}
