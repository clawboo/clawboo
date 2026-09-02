// Read `catalog/packs/**` from disk, for the tests that assert on the CONTENT
// rather than on how the app renders it.
//
// The catalog used to be TypeScript modules the tests could import. It is JSON
// packs in a non-workspace folder now, so the tests read it with `fs` and an
// absolute path instead. Nothing under `src/` imports this outside a test: it
// would drag the whole corpus into the browser graph, which is the exact
// regression `features/layout/__tests__/entryImportGraph.test.ts` polices.
//
// The authoritative content gate is `scripts/catalog/validate.ts` - it is what a
// content-only PR runs, since such a PR skips this test suite entirely. What
// lives here is the half that is about the APP: unique display names so an
// @mention resolves, taxonomy values that resolve to a colour, and the shape the
// browse surfaces depend on.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
export const CATALOG_ROOT = path.join(REPO_ROOT, 'catalog')

export interface PackAgentListing {
  id: string
  packId: string
  slug: string
  name: string
  role: string
  emoji: string
  color: string
  description: string
  category: string
  tags: string[]
  skillIds: string[]
  body: string
  origin?: { url?: string }
  suggestedRuntime?: string
}

export interface PackTeamListing {
  id: string
  packId: string
  slug: string
  name: string
  emoji: string
  color: string
  description: string
  category: string
  tags: string[]
  members: { agentId: string; name: string; role: string }[]
  body: string
  origin?: { url?: string }
  defaultRuntime?: string
}

export interface PackManifest {
  schemaVersion: number
  id: string
  idPrefix?: string
  name: string
  version: string
  provenance: { sourceId: string; label: string; color: string; license: string; repo?: string }
  counts: { agents: number; teams: number; skills: number }
  newCategories?: string[]
  renames?: Record<string, string | null>
  agents: PackAgentListing[]
  teams: PackTeamListing[]
  skills: { id: string }[]
}

export interface PackAgentBody {
  id: string
  files: Record<string, string>
}

export interface PackTeamBody {
  id: string
  workflowNarrative?: string
  routing?: Record<string, string>
}

export interface SourcePack {
  dir: string
  manifest: PackManifest
  agentBodies: Map<string, PackAgentBody>
  teamBodies: Map<string, PackTeamBody>
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function load(): SourcePack[] {
  const config = readJson<{ packs: { publisher: string; slug: string }[] }>(
    path.join(CATALOG_ROOT, 'catalog.config.json'),
  )
  return config.packs.map(({ publisher, slug }) => {
    const dir = path.join(CATALOG_ROOT, 'packs', publisher, slug)
    const manifest = readJson<PackManifest>(path.join(dir, 'pack.json'))
    const agentBodies = new Map<string, PackAgentBody>()
    for (const a of manifest.agents) {
      agentBodies.set(a.id, readJson<PackAgentBody>(path.join(dir, a.body)))
    }
    const teamBodies = new Map<string, PackTeamBody>()
    for (const t of manifest.teams) {
      teamBodies.set(t.id, readJson<PackTeamBody>(path.join(dir, t.body)))
    }
    return { dir, manifest, agentBodies, teamBodies }
  })
}

export const SOURCE_PACKS: SourcePack[] = load()

export const SOURCE_AGENTS: PackAgentListing[] = SOURCE_PACKS.flatMap((p) => p.manifest.agents)
export const SOURCE_TEAMS: PackTeamListing[] = SOURCE_PACKS.flatMap((p) => p.manifest.teams)

const agentBodies = new Map(SOURCE_PACKS.flatMap((p) => [...p.agentBodies]))
const teamBodies = new Map(SOURCE_PACKS.flatMap((p) => [...p.teamBodies]))

export function sourceAgent(id: string): PackAgentListing | undefined {
  return SOURCE_AGENTS.find((a) => a.id === id)
}

export function sourceAgentBody(id: string): PackAgentBody | undefined {
  return agentBodies.get(id)
}

export function sourceTeamBody(id: string): PackTeamBody | undefined {
  return teamBodies.get(id)
}

/** The AGENTS.md a member deploys with: the team's routing, or the agent's own. */
export function routingFor(teamId: string, agentId: string): string | undefined {
  return sourceTeamBody(teamId)?.routing?.[agentId] ?? sourceAgentBody(agentId)?.files['AGENTS.md']
}
