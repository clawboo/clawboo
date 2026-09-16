// ─── Memory REST surface ──────────────────────────────────────
// The UI-facing half of the memory dual surface (the model-facing half is the
// Memory MCP server). Shares the same SqliteMemoryStore + SQLite file the MCP
// server uses (one source of truth).

import {
  SqliteMemoryStore,
  browseMemoryBody,
  feedbackBody,
  memoryGraphQuery,
  outcomesQuery,
  resolveEmbeddingProvider,
  saveMemoryBody,
  searchMemoryBody,
  type EmbeddingProvider,
} from '@clawboo/db'
import type { Request, Response } from 'express'

import { getDb } from '../lib/db'

// Resolve the embedding provider once (a network probe), then reuse. Null →
// FTS-only (vector/hybrid gracefully degrade).
let embedProviderPromise: Promise<EmbeddingProvider | null> | null = null
function getEmbedProvider(): Promise<EmbeddingProvider | null> {
  if (!embedProviderPromise) embedProviderPromise = resolveEmbeddingProvider().catch(() => null)
  return embedProviderPromise
}

function storeFor(): Promise<SqliteMemoryStore> {
  return getEmbedProvider().then((embed) => new SqliteMemoryStore(getDb(), embed))
}

// GET /api/memory?query=&mode=&limit=&teamId=&agentId=
export async function memorySearchGET(req: Request, res: Response): Promise<void> {
  try {
    const q = req.query
    const parsed = searchMemoryBody.safeParse({
      query: typeof q['query'] === 'string' ? q['query'] : '',
      mode: typeof q['mode'] === 'string' ? q['mode'] : undefined,
      limit: typeof q['limit'] === 'string' ? Number(q['limit']) : undefined,
      scope: {
        teamId: typeof q['teamId'] === 'string' ? q['teamId'] : undefined,
        agentId: typeof q['agentId'] === 'string' ? q['agentId'] : undefined,
      },
    })
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', details: parsed.error.flatten() })
      return
    }
    const store = await storeFor()
    const results = await store.searchMemory(parsed.data.query, {
      mode: parsed.data.mode,
      limit: parsed.data.limit,
      scope: parsed.data.scope,
    })
    // Sibling learning map (additive — the results array shape is untouched).
    const learning = await store.learningForFacts(
      results.map((r) => r.id),
      Date.now(),
    )
    res.json({ ok: true, results, learning })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// POST /api/memory — save a fact (default) or a procedure (discriminated).
export async function memorySavePOST(req: Request, res: Response): Promise<void> {
  try {
    const parsed = saveMemoryBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const store = await storeFor()
    // UI saves are user-authored: provenance runtime 'user', no agent id.
    if ('kind' in parsed.data && parsed.data.kind === 'procedure') {
      const proc = await store.saveProcedure({
        name: parsed.data.name,
        content: parsed.data.content,
        scope: parsed.data.scope,
        provenance: { runtime: 'user' },
      })
      res.json({ ok: true, procedure: proc })
      return
    }
    const fact = await store.saveFact({
      title: parsed.data.title,
      content: parsed.data.content,
      tags: parsed.data.tags,
      scope: parsed.data.scope,
      provenance: { runtime: 'user' },
    })
    res.json({ ok: true, fact })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// GET /api/memory/browse?limit=&teamId=&agentId=
export async function memoryBrowseGET(req: Request, res: Response): Promise<void> {
  try {
    const q = req.query
    const parsed = browseMemoryBody.safeParse({
      limit: typeof q['limit'] === 'string' ? Number(q['limit']) : undefined,
      scope: {
        teamId: typeof q['teamId'] === 'string' ? q['teamId'] : undefined,
        agentId: typeof q['agentId'] === 'string' ? q['agentId'] : undefined,
      },
    })
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', details: parsed.error.flatten() })
      return
    }
    const store = await storeFor()
    const [facts, procedures] = await Promise.all([
      store.browseMemory({ limit: parsed.data.limit, scope: parsed.data.scope }),
      store.listProcedures({ limit: parsed.data.limit, scope: parsed.data.scope }),
    ])
    // Sibling learning map (additive — existing keys unchanged).
    const learning = await store.learningForFacts(
      facts.map((f) => f.id),
      Date.now(),
    )
    res.json({ ok: true, facts, procedures, learning })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// GET /api/memory/graph?limit=&teamId=&agentId= — the full graph payload
// (nodes carry their learning entries; the store decorates them internally).
export async function memoryGraphGET(req: Request, res: Response): Promise<void> {
  try {
    const q = req.query
    const parsed = memoryGraphQuery.safeParse({
      limit: typeof q['limit'] === 'string' ? Number(q['limit']) : undefined,
      scope: {
        teamId: typeof q['teamId'] === 'string' ? q['teamId'] : undefined,
        agentId: typeof q['agentId'] === 'string' ? q['agentId'] : undefined,
      },
    })
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', details: parsed.error.flatten() })
      return
    }
    const provider = await getEmbedProvider()
    const store = await storeFor()
    // Deliberately DO NOT pass providerId here: the graph view links any
    // same-model+dims bucket (graph.ts already never compares across models), so
    // facts embedded under a previous provider still show their similarity edges
    // after a model switch. providerId is the injection-path restriction only.
    const graph = await store.getMemoryGraph({
      scope: parsed.data.scope,
      factLimit: parsed.data.limit,
    })
    res.json({
      ok: true,
      graph,
      provider: provider ? { id: provider.id, dimensions: provider.dimensions } : null,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// POST /api/memory/feedback — explicit user feedback on a fact ('cited' is
// internal-only and not accepted here). Prefix ids resolve scope-filtered.
export async function memoryFeedbackPOST(req: Request, res: Response): Promise<void> {
  try {
    const parsed = feedbackBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const store = await storeFor()
    const fact = await store.getFact(parsed.data.factId, parsed.data.scope)
    if (!fact) {
      res.status(404).json({ error: 'unknown fact' })
      return
    }
    if (parsed.data.outcome === 'corrected' && !parsed.data.note?.trim()) {
      res.status(400).json({ error: 'corrected requires a note' })
      return
    }
    const outcome = await store.recordOutcome({
      factId: fact.id,
      outcome: parsed.data.outcome,
      note: parsed.data.note ?? null,
      agentId: parsed.data.scope?.agentId ?? null,
      teamId: parsed.data.scope?.teamId ?? null,
      runtime: 'user',
    })
    const learning = (await store.learningForFacts([fact.id], Date.now()))[fact.id] ?? null
    res.json({ ok: true, outcome, learning })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// GET /api/memory/outcomes?factId=&limit= — a fact's full outcome trail,
// newest-first. Prefix resolution is unscoped: the UI is the operator surface.
export async function memoryOutcomesGET(req: Request, res: Response): Promise<void> {
  try {
    const q = req.query
    const parsed = outcomesQuery.safeParse({
      factId: typeof q['factId'] === 'string' ? q['factId'] : undefined,
      limit: typeof q['limit'] === 'string' ? Number(q['limit']) : undefined,
    })
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', details: parsed.error.flatten() })
      return
    }
    const store = await storeFor()
    const fact = await store.getFact(parsed.data.factId)
    if (!fact) {
      res.status(404).json({ error: 'unknown fact' })
      return
    }
    const outcomes = await store.listOutcomes({ factIds: [fact.id], limit: parsed.data.limit })
    res.json({ ok: true, factId: fact.id, outcomes })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// GET /api/memory/provider — the active embedding provider (or null = FTS-only).
// A thin read so the UI can show how vector/hybrid search is backed (and warn
// that they degrade to FTS when no provider is reachable). Provider-swap-ready:
// the shape is just { id, dimensions }, independent of which provider resolved.
export async function memoryProviderGET(_req: Request, res: Response): Promise<void> {
  try {
    const provider = await getEmbedProvider()
    res.json({ provider: provider ? { id: provider.id, dimensions: provider.dimensions } : null })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
