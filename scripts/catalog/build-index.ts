#!/usr/bin/env tsx
/**
 * `catalog/packs/**` -> `catalog/dist/v1/**`.
 *
 * Two artifacts come out of one walk:
 *
 *   dist/v1/packs/<publisher>/<slug>/<version>.json   the DISTRIBUTION unit: one
 *     self-contained bundle per pack, listings and bodies together. This is what
 *     a remote host serves and what `integrity` is computed over.
 *
 *   dist/v1/index.json   the BROWSE index: every pack projected down to what a
 *     CARD renders, plus a `packs` registry naming each bundle and its integrity.
 *     No agent prose, ever.
 *
 * `catalog/dist/` is COMMITTED. That is what makes the zero-infrastructure
 * fallback URL work on day one: a raw githubusercontent URL against `main`
 * serves the same bytes a CDN would, with no deploy step in between. The bytes
 * are canonical (sorted keys, LF, no trailing newline) so the merge-conflict
 * surface on index.json stays a diff a human can read.
 *
 * Usage:
 *   tsx scripts/catalog/build-index.ts            write dist/
 *   tsx scripts/catalog/build-index.ts --check    fail if dist/ is not what this would write
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  STRICT_LADDER,
  parseAgentPack,
  type AgentPack,
} from '../../packages/pack-format/src/index.ts'
import { canonicalWithIntegrity } from './lib/hash.ts'
import {
  DIST_DIR,
  REPO_ROOT,
  bundlePath,
  bundleUrlPath,
  distDir,
  loadAllPacks,
  loadConfig,
  type CatalogConfig,
  type LoadedPack,
} from './lib/packs.ts'

/** Bumped only when the shape changes in a way a stale client cannot read. */
const INDEX_SCHEMA_VERSION = 1

interface AgentRow {
  id: string
  packId: string
  name: string
  role: string
  emoji: string
  color: string
  description: string
  source: string
  category: string
  tags: string[]
  skillIds: string[]
  suggestedRuntime?: string
}

interface TeamRow {
  id: string
  packId: string
  name: string
  emoji: string
  color: string
  description: string
  category: string
  source: string
  tags: string[]
  agentIds: string[]
  defaultRuntime?: string
}

interface PackRow {
  publisher: string
  slug: string
  id: string
  version: string
  /** Path under the dist root, so one base URL serves index and bundles alike. */
  path: string
  /** `sha256-<base64>` over the bundle's canonical bytes. THE trust anchor. */
  integrity: string
  bytes: number
  counts: { agents: number; teams: number }
  /**
   * Where this content came from, carried into the index so the UI can say it.
   *
   * The pack manifest has REQUIRED a licence since day one and the index used to
   * drop it here, which meant Clawboo demanded provenance from every contributor
   * and then never showed a user any of it. Most of this catalog is other
   * people's work, adapted; a marketplace that cannot name the author, the
   * commit and the licence of what it is handing you is not being straight.
   */
  provenance: {
    label: string
    license: string
    /** Upstream repo URL, or absent for first-party packs written here. */
    repo?: string
    /** The 40-hex commit the import was taken at. Absent when there is no upstream. */
    ref?: string
    authors?: string[]
    /** 'adapted' from an upstream, or 'original' written for Clawboo. */
    adaptation: string
  }
}

interface DistIndex {
  schemaVersion: number
  counts: { agents: number; teams: number }
  agents: AgentRow[]
  teams: TeamRow[]
  packs: PackRow[]
}

/** The bundle: the pack document with its body files inlined. */
export interface PackBundle extends AgentPack {
  bodies: {
    agents: Record<string, { id: string; files: Record<string, string> }>
    teams: Record<
      string,
      { id: string; workflowNarrative?: string; routing?: Record<string, string> }
    >
  }
}

function drop<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

export function agentRow(pack: AgentPack, a: AgentPack['agents'][number]): AgentRow {
  return drop({
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
    suggestedRuntime: a.suggestedRuntime,
  })
}

export function teamRow(pack: AgentPack, t: AgentPack['teams'][number]): TeamRow {
  return drop({
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
    defaultRuntime: t.defaultRuntime,
  })
}

/**
 * Parse every pack through the shared reader before anything is written.
 *
 * STRICT ladder and `staleVersionPolicy: 'error'`: an unknown key in a
 * first-party pack is a typo, and a stale `schemaVersion` in the tree is a
 * build that did not run. A third-party reader uses the loose defaults.
 */
export function parseOrThrow(loaded: LoadedPack): AgentPack {
  const result = parseAgentPack(loaded.pack, {
    ladder: STRICT_LADDER,
    staleVersionPolicy: 'error',
  })
  if (!result.ok) {
    const detail = result.issues.map((i) => `    ${i.path}: ${i.message}`).join('\n')
    throw new Error(
      `${path.relative(REPO_ROOT, loaded.dir)}/pack.json is not a valid pack ` +
        `(${result.code}): ${result.message}\n${detail}`,
    )
  }
  return result.pack
}

export function bundleOf(loaded: LoadedPack, pack: AgentPack): PackBundle {
  const agents: PackBundle['bodies']['agents'] = {}
  for (const listing of pack.agents) {
    const body = loaded.agentBodies.get(listing.id)
    if (!body) throw new Error(`${pack.id}: agent "${listing.id}" has no body at ${listing.body}`)
    agents[listing.id] = body
  }
  const teams: PackBundle['bodies']['teams'] = {}
  for (const listing of pack.teams) {
    const body = loaded.teamBodies.get(listing.id)
    if (!body) throw new Error(`${pack.id}: team "${listing.id}" has no body at ${listing.body}`)
    teams[listing.id] = body
  }
  return { ...pack, bodies: { agents, teams } }
}

export interface BuiltArtifact {
  file: string
  text: string
}

export function build(config: CatalogConfig = loadConfig()): {
  artifacts: BuiltArtifact[]
  index: DistIndex
} {
  const packs = loadAllPacks(config)
  const artifacts: BuiltArtifact[] = []
  const agents: AgentRow[] = []
  const teams: TeamRow[] = []
  const packRows: PackRow[] = []

  for (const loaded of packs) {
    const pack = parseOrThrow(loaded)
    const { text, integrity, bytes } = canonicalWithIntegrity(bundleOf(loaded, pack))
    artifacts.push({ file: bundlePath(config, loaded.ref, pack.version), text })
    packRows.push({
      publisher: loaded.ref.publisher,
      slug: loaded.ref.slug,
      id: pack.id,
      version: pack.version,
      path: bundleUrlPath(config, loaded.ref, pack.version),
      integrity,
      bytes,
      counts: { agents: pack.agents.length, teams: pack.teams.length },
      provenance: {
        label: pack.provenance.label,
        license: pack.provenance.license,
        repo: pack.provenance.repo,
        ref: pack.provenance.ref,
        authors: pack.provenance.authors,
        adaptation: pack.provenance.adaptation,
      },
    })
    for (const a of pack.agents) agents.push(agentRow(pack, a))
    for (const t of pack.teams) teams.push(teamRow(pack, t))
  }

  const index: DistIndex = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    counts: { agents: agents.length, teams: teams.length },
    agents,
    teams,
    packs: packRows,
  }
  artifacts.push({
    file: path.join(distDir(config), 'index.json'),
    text: canonicalWithIntegrity(index).text,
  })
  return { artifacts, index }
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function main(): void {
  const check = process.argv.includes('--check')
  const config = loadConfig()
  const { artifacts, index } = build(config)

  if (check) {
    const stale: string[] = []
    for (const { file, text } of artifacts) {
      const onDisk = existsSync(file) ? readFileSync(file, 'utf8') : null
      if (onDisk !== text) stale.push(path.relative(REPO_ROOT, file))
    }
    if (stale.length > 0) {
      console.error(
        `catalog: ${stale.length} committed artifact(s) do not match catalog/packs/**:\n` +
          stale.map((f) => `  ${f}`).join('\n') +
          '\n\nRun `pnpm catalog:build` and commit the result.',
      )
      process.exit(1)
    }
    console.log(`catalog: dist is current (${artifacts.length} artifact(s))`)
    return
  }

  // Rewritten wholesale so a deleted pack cannot leave a stale bundle behind.
  rmSync(DIST_DIR, { recursive: true, force: true })
  for (const { file, text } of artifacts) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text, 'utf8')
  }
  console.log(
    `catalog: ${index.counts.agents} agents, ${index.counts.teams} teams ` +
      `across ${index.packs.length} pack(s) -> ${path.relative(REPO_ROOT, distDir(config))}`,
  )
  for (const p of index.packs) console.log(`  ${p.id}@${p.version}  ${kb(p.bytes)}  ${p.integrity}`)
  const indexBytes = artifacts[artifacts.length - 1]?.text.length ?? 0
  console.log(`  index.json  ${kb(indexBytes)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('build-index.ts')) main()
