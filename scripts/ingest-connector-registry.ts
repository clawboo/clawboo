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

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers'
const OUT_DIR = path.join(process.cwd(), 'packages/connector-catalog/src/generated')
const OUT_FILE = path.join(OUT_DIR, 'community.ts')

/**
 * The ceiling on the community band.
 *
 * Not a technical limit. 400 entries is roughly 35 KB gzipped behind a dynamic
 * import, so the cost is bearable; the reason for a cap is that a directory
 * nobody can read the end of is a search box with extra steps, and an unbounded
 * one would grow past review with every ingest.
 */
const CAP = 400

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
  _meta?: Record<string, { status?: string; isLatest?: boolean }>
}

async function fetchAll(): Promise<RegistryRow[]> {
  const rows: RegistryRow[] = []
  let cursor: string | undefined
  // Bounded rather than "until exhausted": a paging loop against a preview API is
  // exactly where a cursor bug becomes an infinite request storm.
  for (let page = 0; page < 60; page += 1) {
    const url = new URL(REGISTRY)
    url.searchParams.set('limit', '100')
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

/** A slug clawboo can key a connector on, derived from the registry's reverse-DNS name. */
function slugOf(name: string): string {
  return (
    name
      .split('/')
      .pop()!
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .join('-')
      .slice(0, 48) || ''
  )
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
    if (!pkg.identifier || !pkg.version) continue
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
  const slug = slugOf(s.name!)
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

async function main(): Promise<void> {
  const rows = await fetchAll()
  const seen = new Set<string>()
  const picked = rows
    .filter(usable)
    // Deterministic: sorted by the registry name, which is stable and unique, so
    // two ingests of the same registry state produce byte-identical output and a
    // diff a human reads is a diff of real changes.
    .sort((a, b) => a.server!.name!.localeCompare(b.server!.name!))
    .filter((r) => {
      const slug = slugOf(r.server!.name!)
      if (seen.has(slug)) return false
      seen.add(slug)
      return true
    })
    .slice(0, CAP)

  const body = picked.map(toEntry).join('\n')
  const hash = createHash('sha256').update(body, 'utf8').digest('hex')
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
// Digest:  ${hash}
//
// Refreshing this file is a deliberate act: run the script, read the diff, bump
// the version. Nothing auto-refreshes it.

import type { ConnectorDefinition } from '../types'

export const COMMUNITY_SNAPSHOT: readonly ConnectorDefinition[] = Object.freeze([
${body}
])
`
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, file, 'utf8')
  console.log(
    `\n📦 ${picked.length} community connectors written to ${path.relative(process.cwd(), OUT_FILE)}`,
  )
  console.log(`   digest ${hash.slice(0, 16)}  (from ${rows.length} registry rows)\n`)
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
