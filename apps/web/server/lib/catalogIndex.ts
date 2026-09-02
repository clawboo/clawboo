// Where the marketplace catalog comes from, and why it can never be empty.
//
// The catalog is no longer bundled: `catalog/` is excluded from the npm tarball,
// so an install ships the SEED (the builtin pack, compiled in) and fetches
// everything else. This module resolves the rest and merges it onto the seed.
//
// THREE TIERS, IN ORDER:
//
//   0. THE LOCAL FILESYSTEM. If `catalog/dist/<channel>/` exists above this
//      file, it is used verbatim. That is what makes a repo checkout, a fresh
//      branch, and a `pnpm dev` work with no network at all - including on a
//      branch whose catalog has never been pushed anywhere.
//   1. `CLAWBOO_CATALOG_INDEX_URL`. NOT A FEATURE FLAG (`README.md` says there
//      are none, and that stays true). It is an ENDPOINT OVERRIDE, the same
//      class of setting as `CLAWBOO_ALLOWED_ORIGINS`: both tiers serve the
//      identical generated file, so there is no behavioural fork to reason
//      about, only a different host.
//   2. The default URL below.
//
// NOTHING HERE THROWS. Offline, firewalled, 404, corrupt bytes - every one of
// them returns the seed, because `SelectTeamStep` renders with
// `allowStartFromScratch={false}` and an empty catalog is a first run with
// nothing to click. Modelled on `updateCheck.ts`: cache successes, never cache
// or propagate a failure.
//
// INTEGRITY IS THE ANCHOR, NOT THE URL. The index is mutable; each pack bundle
// it names is immutable and carries `sha256-<base64>` over its exact bytes. A
// bundle's digest is recomputed and compared BEFORE `JSON.parse` ever sees it.
// Unverified bytes are never parsed.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'
import { agentBodyV1, parseAgentPack, teamBodyV1, type AgentPack } from '@clawboo/pack-format'

import {
  SEED_AGENT_BODIES,
  SEED_INDEX,
  SEED_TEAM_BODIES,
  SEED_PACK_ID,
  SEED_PACK_VERSION,
  type SeedAgentBody,
  type SeedAgentRow,
  type SeedTeamBody,
  type SeedTeamRow,
} from './catalogSeed'

const log = createLogger('catalog')

/**
 * The zero-infrastructure default, verified live: 200, `cache-control:
 * max-age=300`, an ETag, and `access-control-allow-origin: *`. A CDN in front of
 * the same generated directory is a drop-in replacement - point
 * `CLAWBOO_CATALOG_INDEX_URL` at it, or change this constant.
 */
const DEFAULT_INDEX_URL =
  'https://raw.githubusercontent.com/clawboo/clawboo/refs/heads/main/catalog/dist/v1/index.json'

/** The dist channel directory name, matching `catalog/catalog.config.json`. */
const CHANNEL = 'v1'

const FETCH_TIMEOUT_MS = 5_000
/**
 * The index is rewritten whenever content merges, so it carries a real TTL. 6h
 * matches `updateCheck.ts`: rare outbound calls for a long-lived dashboard, and
 * still a same-working-day view of new content.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

// ─── Shapes ──────────────────────────────────────────────────────────────────
//
// Declared here rather than imported from `apps/web/src`: the Express server and
// the browser SPA are separate build targets and an eslint boundary forbids the
// import. The pack shapes DO come from `@clawboo/pack-format`, which is exactly
// the package that boundary rule points at.

export interface CatalogPackRef {
  publisher: string
  slug: string
  id: string
  version: string
  /** True for the pack that is compiled in rather than fetched. */
  offline?: boolean
}

interface DirectoryPackRow extends CatalogPackRef {
  /** Path under the dist root, e.g. `v1/packs/clawboo/builtin/1.0.0.json`. */
  path: string
  integrity: string
}

/** `dist/<channel>/index.json`: the browse rows plus the pack directory. */
interface DirectoryIndex {
  schemaVersion: number
  packs?: DirectoryPackRow[]
}

export interface CatalogSnapshot {
  schemaVersion: number
  counts: { agents: number; teams: number }
  agents: SeedAgentRow[]
  teams: SeedTeamRow[]
  packs: CatalogPackRef[]
  agentBodies: Map<string, SeedAgentBody>
  teamBodies: Map<string, SeedTeamBody>
}

// ─── Tier 0: the local filesystem ────────────────────────────────────────────

/**
 * This module's own directory.
 *
 * `__dirname`, NOT `import.meta.url`. Every shape this file runs in provides it:
 * tsup bundles the server to CJS, `apps/web` has no `"type": "module"` so tsx
 * loads it as CJS too, and Vite's SSR transform defines it for vitest. Whereas
 * `import.meta` in a CJS bundle is replaced by an empty object - esbuild warns
 * about it on every build, and `fileURLToPath(undefined)` would throw.
 *
 * The guard is not decoration: if some future loader provides neither, this
 * returns null and the local tier is simply skipped rather than crashing.
 */
function selfDir(): string | null {
  return typeof __dirname === 'string' && __dirname.length > 0 ? __dirname : null
}

/**
 * Walk up from this module looking for `catalog/dist/<channel>/index.json`.
 *
 * Found in a repo checkout (under tsx, and from `apps/web/dist/server.js`);
 * absent from an npm install, where `catalog/` is not in the tarball. The walk
 * is bounded so a pathological layout cannot spin.
 */
function localDistDir(): string | null {
  let dir = selfDir()
  if (dir === null) return null
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'catalog', 'dist', CHANNEL)
    if (existsSync(path.join(candidate, 'index.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ─── The on-disk bundle cache ────────────────────────────────────────────────
//
// Keyed by INTEGRITY, not by URL or version: the digest is what the bytes are
// checked against, so a hit is already proven to be the right bytes. This cache,
// not the CDN, is what makes a second launch free - a sha-pinned raw URL still
// only advertises `max-age=300`.

function cacheDir(): string {
  return path.join(resolveClawbooDir(), 'catalog')
}

function cacheFileFor(integrity: string): string {
  return path.join(cacheDir(), `${createHash('sha256').update(integrity).digest('hex')}.json`)
}

function digestOf(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
}

// ─── Fetching ────────────────────────────────────────────────────────────────

interface FetchResult {
  text: string | null
  etag: string | null
  notModified: boolean
}

async function fetchText(url: string, etag: string | null): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'clawboo-catalog',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
    })
    if (res.status === 304) return { text: null, etag, notModified: true }
    if (!res.ok) return { text: null, etag: null, notModified: false }
    return { text: await res.text(), etag: res.headers.get('etag'), notModified: false }
  } catch {
    // Offline, DNS failure, TLS failure, timeout. Never fatal.
    return { text: null, etag: null, notModified: false }
  }
}

// ─── Flattening a verified bundle ────────────────────────────────────────────

interface RawBundle {
  bodies?: {
    agents?: Record<string, unknown>
    teams?: Record<string, unknown>
  }
}

function rowsOf(pack: AgentPack): { agents: SeedAgentRow[]; teams: SeedTeamRow[] } {
  return {
    agents: pack.agents.map((a) => ({
      id: a.id,
      packId: a.packId,
      name: a.name,
      role: a.role,
      emoji: a.emoji,
      color: a.color,
      description: a.description,
      source: pack.provenance.sourceId,
      category: a.category,
      tags: a.tags,
      skillIds: a.skillIds,
      ...(a.suggestedRuntime ? { suggestedRuntime: a.suggestedRuntime } : {}),
    })),
    teams: pack.teams.map((t) => ({
      id: t.id,
      packId: t.packId,
      name: t.name,
      emoji: t.emoji,
      color: t.color,
      description: t.description,
      category: t.category,
      source: pack.provenance.sourceId,
      tags: t.tags,
      agentIds: t.members.map((m) => m.agentId),
      ...(t.defaultRuntime ? { defaultRuntime: t.defaultRuntime } : {}),
    })),
  }
}

/**
 * Parse one already-verified bundle. Returns null when the pack is unreadable by
 * this build - a pack whose schema is too new drops out and the rest of the
 * catalog still renders. REJECT THE PACK, NEVER THE CATALOG.
 */
function readBundle(text: string): {
  pack: AgentPack
  agentBodies: Map<string, SeedAgentBody>
  teamBodies: Map<string, SeedTeamBody>
} | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = parseAgentPack(doc)
  if (!parsed.ok) {
    log.warn(
      { code: parsed.code, reason: parsed.message },
      'dropping a pack this build cannot read',
    )
    return null
  }
  // `bodies` is the bundle's own key and the loose ladder strips it, so it is
  // read off the raw document and validated on its own.
  const raw = doc as RawBundle
  const agentBodies = new Map<string, SeedAgentBody>()
  for (const listing of parsed.pack.agents) {
    const body = agentBodyV1.safeParse(raw.bodies?.agents?.[listing.id])
    if (!body.success) continue
    agentBodies.set(listing.id, {
      ...body.data,
      ...(listing.origin?.url ? { sourceUrl: listing.origin.url } : {}),
    })
  }
  const teamBodies = new Map<string, SeedTeamBody>()
  for (const listing of parsed.pack.teams) {
    const body = teamBodyV1.safeParse(raw.bodies?.teams?.[listing.id])
    if (!body.success) continue
    teamBodies.set(listing.id, {
      ...body.data,
      ...(listing.origin?.url ? { sourceUrl: listing.origin.url } : {}),
    })
  }
  return { pack: parsed.pack, agentBodies, teamBodies }
}

// ─── The snapshot ────────────────────────────────────────────────────────────

function seedSnapshot(): CatalogSnapshot {
  return {
    schemaVersion: SEED_INDEX.schemaVersion,
    counts: SEED_INDEX.counts,
    agents: [...SEED_INDEX.agents],
    teams: [...SEED_INDEX.teams],
    packs: [
      {
        publisher: 'clawboo',
        slug: 'builtin',
        id: SEED_PACK_ID,
        version: SEED_PACK_VERSION,
        offline: true,
      },
    ],
    agentBodies: new Map(Object.entries(SEED_AGENT_BODIES)),
    teamBodies: new Map(Object.entries(SEED_TEAM_BODIES)),
  }
}

/** Read a bundle's bytes: local file, disk cache, or the network, in that order. */
async function bundleBytes(
  row: DirectoryPackRow,
  local: string | null,
  root: URL | null,
): Promise<string | null> {
  if (local) {
    // `row.path` is `<channel>/packs/...` and `local` already ends in the
    // channel, so the channel segment is dropped rather than repeated.
    const rel = row.path.startsWith(`${CHANNEL}/`) ? row.path.slice(CHANNEL.length + 1) : row.path
    const file = path.join(local, rel)
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  const cached = cacheFileFor(row.integrity)
  if (existsSync(cached)) return readFileSync(cached, 'utf8')
  if (!root) return null
  const { text } = await fetchText(new URL(row.path, root).toString(), null)
  if (text === null) return null
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(cached, text, 'utf8')
  } catch {
    // A read-only or full home directory costs a re-fetch, never correctness.
  }
  return text
}

// The 6h snapshot cache, plus the conditional-request state the index fetch
// carries between calls. Declared here because `buildSnapshot` reads them.
let cache: { snapshot: CatalogSnapshot; at: number } | null = null
let inFlight: Promise<CatalogSnapshot> | null = null
let etagCache: string | null = null
let bodyCache: string | null = null

async function buildSnapshot(): Promise<CatalogSnapshot> {
  const snapshot = seedSnapshot()

  const local = localDistDir()
  const url = process.env['CLAWBOO_CATALOG_INDEX_URL']?.trim() || DEFAULT_INDEX_URL
  let directoryText: string | null = null
  let root: URL | null = null

  if (local) {
    directoryText = readFileSync(path.join(local, 'index.json'), 'utf8')
  } else {
    const result = await fetchText(url, etagCache)
    if (result.etag) etagCache = result.etag
    if (result.notModified && bodyCache) directoryText = bodyCache
    else if (result.text !== null) {
      directoryText = result.text
      bodyCache = result.text
    }
    try {
      root = new URL('../', url)
    } catch {
      root = null
    }
  }
  if (directoryText === null) return snapshot

  let directory: DirectoryIndex
  try {
    directory = JSON.parse(directoryText) as DirectoryIndex
  } catch {
    return snapshot
  }
  // Index-level: a directory this build cannot read means seed only. Row-level
  // (per pack) compatibility is handled by the parser, one pack at a time.
  if (typeof directory.schemaVersion !== 'number' || directory.schemaVersion > 1) {
    log.warn(
      { schemaVersion: directory.schemaVersion },
      'catalog index is newer than this build reads; showing builtins only',
    )
    return snapshot
  }

  const agents = new Map(snapshot.agents.map((a) => [a.id, a]))
  const teams = new Map(snapshot.teams.map((t) => [t.id, t]))
  const packs = new Map(snapshot.packs.map((p) => [p.id, p]))

  for (const row of directory.packs ?? []) {
    const text = await bundleBytes(row, local, root)
    if (text === null) continue
    // RECOMPUTE AND COMPARE BEFORE PARSING. Bytes that fail here are discarded
    // without ever reaching JSON.parse.
    if (digestOf(text) !== row.integrity) {
      log.warn({ pack: row.id }, 'discarding a pack whose bytes do not match its integrity')
      continue
    }
    const bundle = readBundle(text)
    if (!bundle) continue
    const { agents: agentRows, teams: teamRows } = rowsOf(bundle.pack)
    for (const a of agentRows) agents.set(a.id, a)
    for (const t of teamRows) teams.set(t.id, t)
    for (const [id, body] of bundle.agentBodies) snapshot.agentBodies.set(id, body)
    for (const [id, body] of bundle.teamBodies) snapshot.teamBodies.set(id, body)
    packs.set(row.id, {
      publisher: row.publisher,
      slug: row.slug,
      id: row.id,
      version: row.version,
    })
  }

  snapshot.agents = [...agents.values()]
  snapshot.teams = [...teams.values()]
  snapshot.packs = [...packs.values()]
  snapshot.counts = { agents: snapshot.agents.length, teams: snapshot.teams.length }
  return snapshot
}

/**
 * The merged catalog: the compiled seed union every pack whose bytes verified.
 * Never throws, never returns an empty catalog. Cached for 6h, and concurrent
 * callers share one build.
 */
export async function getCatalogSnapshot(now: number = Date.now()): Promise<CatalogSnapshot> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.snapshot
  inFlight ??= buildSnapshot()
    .catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'catalog resolution failed; serving the builtin pack',
      )
      return seedSnapshot()
    })
    .then((snapshot) => {
      cache = { snapshot, at: Date.now() }
      inFlight = null
      return snapshot
    })
  return inFlight
}

/** Drop every cache. Tests, and a forced re-check. */
export function resetCatalogCache(): void {
  cache = null
  inFlight = null
  etagCache = null
  bodyCache = null
}
