// ─── Memory REST surface ──────────────────────────────────────
// The UI-facing half of the memory dual surface (the model-facing half is the
// Memory MCP server). Shares the same SqliteMemoryStore + SQLite file the MCP
// server uses (one source of truth).

import {
  SqliteMemoryStore,
  browseMemoryBody,
  createDb,
  resolveEmbeddingProvider,
  saveMemoryBody,
  searchMemoryBody,
  type EmbeddingProvider,
} from '@clawboo/db'
import type { Request, Response } from 'express'

import { getDbPath } from '../lib/db'

// Resolve the embedding provider once (a network probe), then reuse. Null →
// FTS-only (vector/hybrid gracefully degrade).
let embedProviderPromise: Promise<EmbeddingProvider | null> | null = null
function getEmbedProvider(): Promise<EmbeddingProvider | null> {
  if (!embedProviderPromise) embedProviderPromise = resolveEmbeddingProvider().catch(() => null)
  return embedProviderPromise
}

function storeFor(): Promise<SqliteMemoryStore> {
  return getEmbedProvider().then((embed) => new SqliteMemoryStore(createDb(getDbPath()), embed))
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
    res.json({ ok: true, results })
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
    if ('kind' in parsed.data && parsed.data.kind === 'procedure') {
      const proc = await store.saveProcedure({
        name: parsed.data.name,
        content: parsed.data.content,
        scope: parsed.data.scope,
      })
      res.json({ ok: true, procedure: proc })
      return
    }
    const fact = await store.saveFact({
      title: parsed.data.title,
      content: parsed.data.content,
      tags: parsed.data.tags,
      scope: parsed.data.scope,
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
    res.json({ ok: true, facts, procedures })
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
