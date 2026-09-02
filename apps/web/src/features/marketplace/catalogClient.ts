// Fetch layer for the marketplace catalog.
//
// The catalog is JSON packs under `catalog/`, excluded from the npm tarball and
// fetched at runtime. `apps/web/server/api/catalog.ts` is what talks to a
// remote: it verifies pack integrity, merges the compiled seed, and flattens
// packs down to entries. This module only ever talks to that same-origin API,
// so the browser needs no integrity logic and no second URL.
//
// FOUR THINGS HERE ARE DELIBERATE.
//
// 1. No top-level await. A module whose top-level await rejects is cached as
//    failed in the browser's module map and no retry can re-run it, which is the
//    same trap `lib/lazyRetry.ts` documents for lazy chunks. A module-scoped
//    promise that is CLEARED ON REJECTION makes a dropped fetch genuinely
//    retryable.
//
// 2. The content type is checked. `server/lib/serveSpa.ts` answers any unmatched
//    GET with index.html at 200 text/html, so `res.ok` alone would happily hand
//    an HTML document to `JSON.parse` and report a syntax error instead of a
//    missing route.
//
// 3. `apiFetch`, not bare `fetch`. It resolves the path against the base the
//    server templated into the shell, so the same bundle works at `/` and at
//    `/clawboo/`, and against a remote origin for a non-web client.
//
// 4. THE INDEX LOAD NEVER REJECTS. `SelectTeamStep` renders with
//    `allowStartFromScratch={false}`: an empty catalog is not a degraded browse
//    experience, it is a first run with nothing to click. So a failed request
//    resolves the COMPILED SEED and reports the error alongside it, and the
//    caller renders the builtin teams plus a retry affordance rather than a dead
//    end. Bodies fall back the same way, for the seed's own entries.

import { apiFetch } from '@clawboo/control-client'

import {
  CATALOG_SCHEMA_VERSION,
  type AgentBody,
  type CatalogIndex,
  type TeamBody,
} from './catalogTypes'
import { SEED_AGENT_BODIES, SEED_INDEX, SEED_TEAM_BODIES } from './seed'

const CATALOG_ROOT = '/api/catalog'

export class CatalogFetchError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message)
    this.name = 'CatalogFetchError'
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await apiFetch(path)
  } catch (cause) {
    throw new CatalogFetchError(
      `Could not reach the catalog. ${cause instanceof Error ? cause.message : String(cause)}`,
      path,
    )
  }
  if (!res.ok) {
    throw new CatalogFetchError(`Catalog request failed with ${res.status}.`, path)
  }
  // The SPA fallback returns the shell at 200 text/html for anything unmatched,
  // so a missing route looks like success until the body is inspected.
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) {
    throw new CatalogFetchError(`Expected JSON but received "${type || 'no content-type'}".`, path)
  }
  return (await res.json()) as T
}

// ─── Index ───────────────────────────────────────────────────────────────────

/** What loaded, and what went wrong if the rows are the compiled seed. */
export interface CatalogIndexResult {
  index: CatalogIndex
  /** `null` on success. Set when `index` is the seed rather than the server's. */
  error: CatalogFetchError | null
}

const INDEX_PATH = `${CATALOG_ROOT}/index`

let indexPromise: Promise<CatalogIndexResult> | null = null

export function loadCatalogIndex(): Promise<CatalogIndexResult> {
  indexPromise ??= getJson<CatalogIndex>(INDEX_PATH)
    .then((index): CatalogIndexResult => {
      if (index.schemaVersion !== CATALOG_SCHEMA_VERSION) {
        throw new CatalogFetchError(
          `Catalog schema ${index.schemaVersion} is not readable by this build ` +
            `(expected ${CATALOG_SCHEMA_VERSION}).`,
          INDEX_PATH,
        )
      }
      return { index, error: null }
    })
    .catch((cause: unknown): CatalogIndexResult => {
      // Cleared so the next caller retries rather than replaying the fallback.
      indexPromise = null
      const error =
        cause instanceof CatalogFetchError
          ? cause
          : new CatalogFetchError(String(cause), INDEX_PATH)
      return { index: SEED_INDEX, error }
    })
  return indexPromise
}

// ─── Bodies ──────────────────────────────────────────────────────────────────

const agentBodies = new Map<string, Promise<AgentBody>>()
const teamBodies = new Map<string, Promise<TeamBody>>()

function loadBody<T>(
  cache: Map<string, Promise<T>>,
  dir: string,
  id: string,
  seed: Record<string, T>,
): Promise<T> {
  const hit = cache.get(id)
  if (hit) return hit
  const p = getJson<T>(`${CATALOG_ROOT}/${dir}/${encodeURIComponent(id)}`).catch((err: unknown) => {
    cache.delete(id)
    // A builtin entry is readable with no network at all: the same bytes are
    // compiled into this bundle. Anything else is a genuine failure.
    const fallback = seed[id]
    if (fallback) return fallback
    throw err
  })
  cache.set(id, p)
  return p
}

export function loadAgentBody(id: string): Promise<AgentBody> {
  return loadBody<AgentBody>(agentBodies, 'agents', id, SEED_AGENT_BODIES)
}

export function loadTeamBody(id: string): Promise<TeamBody> {
  return loadBody<TeamBody>(teamBodies, 'teams', id, SEED_TEAM_BODIES)
}

/** Resolve many agent bodies at once. Used by the deploy path, whose largest
 *  team is 11 members, so this is a bounded fan-out rather than a batch API. */
export function loadAgentBodies(ids: readonly string[]): Promise<AgentBody[]> {
  return Promise.all(ids.map(loadAgentBody))
}

/** Drop every memoized response. Tests only. */
export function resetCatalogClient(): void {
  indexPromise = null
  agentBodies.clear()
  teamBodies.clear()
}
