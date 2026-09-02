// Serve the REAL catalog to component tests, through the same routes the app
// calls, and fail loudly when it is missing.
//
// The app reads `/api/catalog/*`. `apps/web/server/api/catalog.ts` answers those
// by verifying pack bundles and flattening them to entries; these handlers do
// the flattening half against the committed `catalog/dist/`, which is the same
// bytes the server would fetch. Integrity is not re-checked here - that is the
// server's job and it has its own tests - but the SHAPE is exactly what the
// browser sees in production.
//
// Tests read the real 131/10 catalog rather than a hand-written fixture on
// purpose: a fixture drifts, and the fetch layer itself is what these exercise.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { http, HttpResponse } from 'msw'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The committed, generated catalog. `pnpm catalog:build` writes it. */
export const CATALOG_DIST = path.join(REPO_ROOT, 'catalog/dist/v1')
export const CATALOG_INDEX_FILE = path.join(CATALOG_DIST, 'index.json')

export function assertCatalogEmitted(): void {
  if (fs.existsSync(CATALOG_INDEX_FILE)) return
  throw new Error(
    `The marketplace catalog has not been built, so catalog-backed tests cannot run.\n` +
      `  expected: ${CATALOG_INDEX_FILE}\n` +
      `  fix:      pnpm catalog:build\n` +
      `  (catalog/dist is COMMITTED, so a missing one means it was deleted, not that\n` +
      `   a build step was skipped.)`,
  )
}

interface PackRow {
  path: string
}

interface Listing {
  id: string
  origin?: { url?: string }
}

interface Bundle {
  agents: Listing[]
  teams: Listing[]
  bodies: {
    agents: Record<string, Record<string, unknown>>
    teams: Record<string, Record<string, unknown>>
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

/**
 * Every body in every committed bundle, keyed by entry id, with `origin.url`
 * flattened onto it as `sourceUrl` exactly the way the server does it.
 */
function bodies(): {
  agents: Record<string, Record<string, unknown>>
  teams: Record<string, Record<string, unknown>>
} {
  const out = { agents: {}, teams: {} } as {
    agents: Record<string, Record<string, unknown>>
    teams: Record<string, Record<string, unknown>>
  }
  if (!fs.existsSync(CATALOG_INDEX_FILE)) return out
  const index = readJson<{ packs?: PackRow[] }>(CATALOG_INDEX_FILE)
  for (const pack of index.packs ?? []) {
    // `path` is `v1/packs/...`; CATALOG_DIST already ends in the channel.
    const rel = pack.path.replace(/^v1\//, '')
    const bundle = readJson<Bundle>(path.join(CATALOG_DIST, rel))
    for (const kind of ['agents', 'teams'] as const) {
      for (const listing of bundle[kind]) {
        const body = bundle.bodies[kind][listing.id]
        if (!body) continue
        out[kind][listing.id] = listing.origin?.url
          ? { ...body, sourceUrl: listing.origin.url }
          : body
      }
    }
  }
  return out
}

let cached: ReturnType<typeof bodies> | null = null
function allBodies(): ReturnType<typeof bodies> {
  cached ??= bodies()
  return cached
}

function json(value: unknown | undefined): Response {
  if (value === undefined) return new HttpResponse(null, { status: 404 })
  return HttpResponse.json(value as Record<string, unknown>)
}

/** Default handlers, so they survive `resetHandlers()` between tests. */
export const catalogHandlers = [
  http.get('/api/catalog/index', () => json(readJson(CATALOG_INDEX_FILE))),
  http.get('/api/catalog/agents/:id', ({ params }) => json(allBodies().agents[String(params.id)])),
  http.get('/api/catalog/teams/:id', ({ params }) => json(allBodies().teams[String(params.id)])),
]
