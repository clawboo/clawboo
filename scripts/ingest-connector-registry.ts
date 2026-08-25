#!/usr/bin/env tsx
// Snapshot the official MCP registry into a committed file.
//
// WHY A SNAPSHOT AND NOT A FETCH. The registry is a preview API that ships
// data-reset warnings, and clawboo's connectors tab promises a directory with no
// loading state in an `npx clawboo` running on a plane. A live fetch would break
// both: the shelf would be empty offline, and the set of things on it would
// change under the user without a release. The committed file IS the content
// address, exactly like the marketplace catalog, and `pnpm verify:connectors`
// checks it with the network off.
//
// WHY THIS IS NOT RUN ON THE RELEASE PATH. A new snapshot is a version bump and a
// diff a human reads. Auto-refreshing would turn a reviewed directory into an
// unreviewed installer that changes silently, which is the one thing the
// community band must never become.
//
// Run: pnpm tsx scripts/ingest-connector-registry.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { isExactVersion } from '../packages/connector-catalog/src/version.js'
import {
  COMMUNITY_SNAPSHOT_CAP,
  DIGEST_PLACEHOLDER,
  digestLine,
  snapshotDigest,
} from './lib/connector-snapshot.js'

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers'
const OUT_DIR = path.join(process.cwd(), 'packages/connector-catalog/src/generated')
const OUT_FILE = path.join(OUT_DIR, 'community.ts')

/**
 * The ceiling on the community band.
 *
 * Not a technical limit, and now the BINDING one: since the paging fix below,
 * roughly 10,700 registry entries pass every runnability gate, so this number
 * decides the size of the shelf rather than merely bounding it. Measured cost
 * of the alternatives, behind the dynamic import: 400 is 52 KB gzipped and
 * 387 KB of JS to parse; 1,000 is 128 KB and 964 KB; 3,000 is 399 KB and
 * 2.9 MB. Raising it is a product call about how much parse time a click on
 * "Unchecked" may cost, not a technical blocker.
 *
 * The reason for having a cap at all is unchanged: a directory nobody can read
 * the end of is a search box with extra steps, and an unbounded one would grow
 * past review with every ingest.
 */
const CAP = COMMUNITY_SNAPSHOT_CAP

interface RegistryPackage {
  registryType?: string
  identifier?: string
  version?: string
  transport?: { type?: string }
  environmentVariables?: { name?: string; description?: string; isRequired?: boolean }[]
}

interface RegistryServer {
  name?: string
  title?: string
  description?: string
  version?: string
  packages?: RegistryPackage[]
  remotes?: { type?: string; url?: string }[]
}

interface RegistryRow {
  server?: RegistryServer
  _meta?: Record<
    string,
    { status?: string; isLatest?: boolean; updatedAt?: string; publishedAt?: string }
  >
}

async function fetchAll(): Promise<RegistryRow[]> {
  const rows: RegistryRow[] = []
  let cursor: string | undefined
  // Bounded rather than "until exhausted": a paging loop against a preview API is
  // exactly where a cursor bug becomes an infinite request storm. The bound is a
  // BACKSTOP, not a budget, and it was previously neither.
  //
  // THE BUG THIS FIXES was silent and total. The registry returns rows in
  // ascending name order, so a 60-page bound did not sample the registry, it
  // TRUNCATED it alphabetically: the walk stopped at `com.blockscout/...` and
  // never reached `io.github.*`, which is where nearly every well-known
  // open-source MCP server publishes. The long tail was an alphabetical prefix
  // of obscure entries, and no amount of re-ordering downstream could have
  // fixed it, because the good entries were never fetched at all.
  for (let page = 0; page < 400; page += 1) {
    const url = new URL(REGISTRY)
    url.searchParams.set('limit', '100')
    // LATEST VERSIONS ONLY, asked of the server rather than filtered here. The
    // default listing carries every historical version of every server, so
    // roughly a third of what came back was superseded rows this script then
    // discarded: two thirds of the paging budget spent fetching rows to throw
    // away.
    url.searchParams.set('version', 'latest')
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`registry returned ${res.status}`)
    const body = (await res.json()) as {
      servers?: RegistryRow[]
      metadata?: { nextCursor?: string }
    }
    rows.push(...(body.servers ?? []))
    const next = body.metadata?.nextCursor
    if (!next || next === cursor) break
    cursor = next
  }
  return rows
}

/** Lowercase, dash-joined, bounded. The shared shape of every slug below. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 48)
}

/** A slug clawboo can key a connector on, derived from the registry's reverse-DNS name. */
function slugOf(name: string): string {
  return normalize(name.split('/').pop() ?? '')
}

/**
 * The same slug with its publisher attached, for when the bare one collides.
 *
 * SIXTY-SIX SERVERS ARE LITERALLY NAMED `<publisher>/mcp`, so the bare leaf is
 * not a name, it is a category. Without this the dedup silently kept whichever
 * one happened to sort first and dropped the other sixty-five, and which one
 * won depended on the sort order rather than on anything a reader could see.
 */
function qualifiedSlugOf(name: string): string {
  const [publisher = '', leaf = ''] = [name.split('/')[0] ?? '', name.split('/').pop() ?? '']
  // The publisher's own last segment: `io.github.taazkareem` reads as
  // `taazkareem`, which is the part a human would use to tell two apart.
  const who = normalize(publisher.split('.').pop() ?? '')
  const what = normalize(leaf)
  return normalize(who && what !== who ? `${who}-${what}` : what)
}

/**
 * The first package on a row that clawboo could actually run, or null.
 *
 * SEARCHES THE LIST rather than taking `packages[0]`. A registry row often lists
 * several: a Docker image, a remote wrapper, and an npm package, in whatever
 * order the publisher wrote them. Judging the row by its first entry silently
 * dropped servers whose second entry was a perfectly good pinned npm package.
 *
 * DELIBERATELY STRICT about what qualifies, and every clause is a thing that
 * would otherwise become a card offering something that cannot work:
 * - a real npm or PyPI identity, because the consent step shows exact argv
 * - a pinnable version, because an unpinned `@latest` re-resolves on every spawn
 * - stdio only, because a remote entry needs OAuth discovery this path has not run
 */
function runnablePackage(row: RegistryRow): RegistryPackage | null {
  for (const pkg of row.server?.packages ?? []) {
    if (pkg.registryType !== 'npm' && pkg.registryType !== 'pypi') continue
    if (!pkg.identifier) continue
    // AN EXACT VERSION, not merely a non-empty one. The registry's `version` is
    // publisher-supplied and unvalidated, so `latest` and `^1.2.0` both arrive
    // here looking like data. Either would produce a consent step that shows one
    // command and runs whatever resolves on the day, which is the one thing the
    // community band must never do.
    if (!isExactVersion(pkg.version, pkg.registryType)) continue
    if ((pkg.transport?.type ?? 'stdio') !== 'stdio') continue
    return pkg
  }
  return null
}

/** Whether this row can become a definition clawboo could actually run. */
function usable(row: RegistryRow): boolean {
  const s = row.server
  if (!s?.name || !s.description?.trim() || !slugOf(s.name)) return false
  const official = row._meta?.['io.modelcontextprotocol.registry/official']
  // Not superseded: the registry keeps old versions in the same list.
  if (official?.status !== 'active' || official.isLatest === false) return false
  return runnablePackage(row) !== null
}

function toEntry(row: RegistryRow): string {
  const s = row.server!
  const pkg = runnablePackage(row)!
  const slug = slugFor.get(row) ?? slugOf(s.name!)
  const npm = pkg.registryType === 'npm'
  const command = npm ? 'npx' : 'uvx'
  const args = npm
    ? ['-y', `${pkg.identifier}@${pkg.version}`]
    : [`${pkg.identifier}==${pkg.version}`]
  const inputs = (pkg.environmentVariables ?? [])
    .filter((e) => e.name)
    .map(
      (e) =>
        `      { key: ${JSON.stringify(e.name)}, description: ${JSON.stringify(
          e.description?.trim() || 'Required by this server.',
        )}, required: ${e.isRequired !== false}, secret: true },`,
    )
  return `  {
    slug: ${JSON.stringify(slug)},
    displayName: ${JSON.stringify((s.title || slug).slice(0, 60))},
    description: ${JSON.stringify(s.description!.trim().slice(0, 200))},
    category: 'other',
    provenance: 'community',
    launch: {
      transport: 'stdio',
      command: ${JSON.stringify(command)},
      args: ${JSON.stringify(args)},
      pinnedVersion: ${JSON.stringify(pkg.version!)},
    },
    auth: {
      kind: ${inputs.length > 0 ? "'api-key'" : "'none'"},
      inputs: [
${inputs.join('\n')}
      ],
    },
    // UNKNOWN, declared as the worst case. clawboo has not read this server, so
    // assuming anything narrower would be vouching for it by omission.
    egressAllow: ['*'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: [],
    catalogId: ${JSON.stringify(s.name!)},
  },`
}

/**
 * The slug the dedup settled on for a row.
 *
 * Held beside the rows rather than recomputed in `toEntry`, because the choice
 * between the bare and the qualified form is made once, during dedup, and
 * recomputing it there would be a second implementation free to disagree.
 */
const slugFor = new Map<RegistryRow, string>()

async function main(): Promise<void> {
  const rows = await fetchAll()
  const runnable = rows.filter(usable)

  // SELECTION AND ORDERING ARE TWO DIFFERENT DECISIONS, and collapsing them is
  // what made the old snapshot arbitrary. Sorting by name and then taking the
  // first CAP does not choose 400 servers, it chooses the alphabet's opening:
  // everything past the cut is invisible however good it is.
  //
  // SELECTED BY RECENCY, because the registry publishes no popularity signal of
  // any kind (no downloads, no stars: the schema is closed and carries none),
  // and "most recently updated" is the only in-band proxy for "somebody still
  // maintains this". It is also DETERMINISTIC against a given registry state,
  // which a download count fetched from npm would not be: a one-day gap between
  // ingests reorders most of that list while the registry itself is unchanged,
  // producing a large diff carrying no information.
  const recency = (r: RegistryRow): string =>
    r._meta?.['io.modelcontextprotocol.registry/official']?.updatedAt ??
    r._meta?.['io.modelcontextprotocol.registry/official']?.publishedAt ??
    ''
  const selected = [...runnable].sort((a, b) => {
    const d = recency(b).localeCompare(recency(a))
    // Name breaks the tie, so equal timestamps cannot make the output depend on
    // the order the registry happened to return.
    return d !== 0 ? d : a.server!.name!.localeCompare(b.server!.name!)
  })

  // Dedup runs over the SELECTED order, and a collision falls back to the
  // publisher-qualified slug rather than dropping the entry: sixty-six servers
  // are named `<publisher>/mcp`, and silently keeping one of them was a worse
  // answer than keeping several under names that tell them apart.
  const seen = new Set<string>()
  const picked: RegistryRow[] = []
  for (const r of selected) {
    if (picked.length >= CAP) break
    const bare = slugOf(r.server!.name!)
    const slug = !seen.has(bare) ? bare : qualifiedSlugOf(r.server!.name!)
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    slugFor.set(r, slug)
    picked.push(r)
  }
  // WRITTEN ALPHABETICALLY even though it was SELECTED by recency, so the
  // committed diff reads as a set difference (these arrived, those left) rather
  // than as a reshuffle of four hundred lines every time.
  picked.sort((a, b) => a.server!.name!.localeCompare(b.server!.name!))

  const body = picked.map(toEntry).join('\n')
  const file = `// GENERATED by scripts/ingest-connector-registry.ts. Do not edit by hand.
//
// A snapshot of the official MCP registry, committed so the connectors tab has a
// directory with no loading state and no network. clawboo has NOT read these
// servers: they carry provenance 'community', which the UI renders in its own
// band with its own count, and which \`connectRefusal\` refuses to connect
// directly. Adding one is an explicit consent step that shows the exact argv.
//
// Source:  ${REGISTRY}
// Entries: ${picked.length} of ${rows.length} registry rows (cap ${CAP})
${DIGEST_PLACEHOLDER}
//
// Refreshing this file is a deliberate act: run the script, read the diff, bump
// the version. Nothing auto-refreshes it.

import type { ConnectorDefinition } from '../types'

export const COMMUNITY_SNAPSHOT: readonly ConnectorDefinition[] = Object.freeze([
${body}
])
`
  mkdirSync(OUT_DIR, { recursive: true })
  // TWO PASSES, because the digest covers the file it lives in: write with a
  // placeholder, hash the canonical form of that, then substitute the real
  // value. `snapshotDigest` blanks the line again on the way in, so the second
  // write hashes to the same thing the verifier will compute.
  const digest = await snapshotDigest(file, OUT_FILE)
  writeFileSync(OUT_FILE, file.replace(DIGEST_PLACEHOLDER, digestLine(digest)), 'utf8')
  // The count module: the snapshot's size, importable by the main entry without
  // its 220 KB body. Regenerated together so the two can never disagree.
  writeFileSync(
    path.join(OUT_DIR, 'communityCount.ts'),
    `// GENERATED by scripts/ingest-connector-registry.ts. Do not edit by hand.
//
// The snapshot's SIZE, importable without its 220 KB body. The community
// entries live behind the './community' entry point so they stay out of first
// paint, which left the main entry unable to say how many there are: the
// header's "plus N clawboo has not checked" line was reading a permanently
// empty array and never rendered. A number travels free.
//
// Digest of the snapshot this count was taken from: ${digest}

export const COMMUNITY_COUNT = ${picked.length}
`,
    'utf8',
  )
  console.log(
    `\n📦 ${picked.length} community connectors written to ${path.relative(process.cwd(), OUT_FILE)}`,
  )
  console.log(`   digest ${digest.slice(0, 16)}  (from ${rows.length} registry rows)\n`)
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
