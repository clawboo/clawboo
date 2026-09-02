#!/usr/bin/env tsx
/**
 * ONE-SHOT MIGRATION. Evaluates the committed TypeScript catalog barrels and
 * writes them out as `catalog/packs/**` JSON, after which those barrels are
 * deleted and this script has nothing left to read.
 *
 * It is kept in the tree rather than thrown away because it is the only written
 * record of how the TS field names map onto the pack format: `soulTemplate` ->
 * `files['SOUL.md']`, a per-entry `sourceUrl` -> `origin.url`, `agentIds` ->
 * denormalised `members`, and the five clawboo team ids gaining the pack prefix
 * the format requires. Re-running it after the barrels are gone is a loud
 * ENOENT, not a silent no-op.
 *
 * It EVALUATES the barrels rather than reading them as text. The prose lives
 * inside template literals; reading the files as text is what manufactured
 * cross-entry false positives for the retired injection scanner.
 *
 * Usage: tsx scripts/catalog/convert-from-source.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { AGENT_CATALOG } from '../../apps/web/src/features/marketplace/agents/index.ts'
import { TEAM_CATALOG } from '../../apps/web/src/features/marketplace/teams/index.ts'
import type { AgentCatalogEntry, TeamTemplate } from '../../apps/web/src/features/teams/types.ts'
import type {
  AgentBody,
  AgentListing,
  AgentPack,
  TeamBody,
  TeamListing,
} from '../../packages/pack-format/src/index.ts'
import { PACKS_DIR, loadConfig, packDir, type PackRef } from './lib/packs.ts'

/** The instant the packs were cut. Fixed, so a re-run is byte-identical. */
const IMPORTED_AT = '2026-08-25T00:00:00.000Z'

interface PackPlan {
  ref: PackRef
  id: string
  idPrefix: string
  name: string
  description: string
  version: string
  provenance: AgentPack['provenance']
  /** Former id -> current id. Recorded in the manifest, not applied at read time. */
  renames?: Record<string, string | null>
  notice: string
}

const CLAWBOO_TEAM_RENAMES: Record<string, string> = {
  dev: 'clawboo-dev',
  marketing: 'clawboo-marketing',
  research: 'clawboo-research',
  student: 'clawboo-student',
  youtube: 'clawboo-youtube',
}

const PLANS: PackPlan[] = [
  {
    ref: { publisher: 'clawboo', slug: 'builtin' },
    id: 'clawboo',
    idPrefix: 'clawboo',
    name: 'Clawboo Builtins',
    description:
      'The five built-in teams and the fifteen agents behind them. This is the pack ' +
      'compiled into the app as the offline seed, so first-run onboarding works with no ' +
      'network at all.',
    version: '1.0.0',
    provenance: {
      sourceId: 'clawboo',
      label: 'Clawboo',
      color: '#34D399',
      repo: 'https://github.com/clawboo/clawboo',
      license: 'MIT',
      authors: ['Clawboo maintainers'],
      adaptation: 'original',
      importedAt: IMPORTED_AT,
    },
    renames: CLAWBOO_TEAM_RENAMES,
    notice: [
      '# Clawboo Builtins',
      '',
      'Original content, written by the Clawboo maintainers and licensed MIT under the',
      'repository LICENSE.',
      '',
      'Copyright (c) Clawboo maintainers',
      '',
    ].join('\n'),
  },
  {
    ref: { publisher: 'agency', slug: 'agents' },
    id: 'agency-agents',
    idPrefix: 'agency',
    name: 'Agency Agents',
    description:
      'Role-specialist agents and workflow teams adapted from the MIT-licensed ' +
      'agency-agents repository. Entries were pruned, renamed, re-described and ' +
      're-formatted; the bodies are adapted, not verbatim.',
    version: '1.0.0',
    provenance: {
      sourceId: 'agency-agents',
      label: 'Agency Agents',
      color: '#3B82F6',
      repo: 'https://github.com/msitarzewski/agency-agents',
      ref: '64eee9f8e04f69b04e78e150d771a443c64720be',
      license: 'MIT',
      authors: ['msitarzewski'],
      adaptation: 'adapted',
      importedAt: IMPORTED_AT,
    },
    notice: [
      '# Agency Agents',
      '',
      '**Source**: https://github.com/msitarzewski/agency-agents',
      '**Pinned commit**: `64eee9f8e04f69b04e78e150d771a443c64720be`',
      '**License verified**: MIT, confirmed at the pinned commit on 2026-07-28',
      '(GitHub license API, `spdx_id: MIT`). Because the import was commit-pinned, a',
      'later upstream relicense does not affect the grant that applied at this commit;',
      're-verify if the pin is ever moved.',
      '',
      '**Modifications**: entries were pruned, renamed, re-described and re-formatted by',
      'the Clawboo maintainers. Bodies are adapted, not verbatim.',
      '',
      'MIT License',
      '',
      'Copyright (c) 2024 msitarzewski',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.',
      '',
    ].join('\n'),
  },
]

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function slugOf(id: string, idPrefix: string): string {
  const prefix = `${idPrefix}-`
  if (!id.startsWith(prefix)) {
    throw new Error(`entry "${id}" does not carry the "${prefix}" prefix its pack emits`)
  }
  const slug = id.slice(prefix.length)
  if (!SLUG.test(slug)) throw new Error(`entry "${id}" produces a non-kebab slug "${slug}"`)
  return slug
}

function agentOf(a: AgentCatalogEntry, plan: PackPlan): { listing: AgentListing; body: AgentBody } {
  const slug = slugOf(a.id, plan.idPrefix)
  const files: Record<string, string> = {
    'SOUL.md': a.soulTemplate,
    'IDENTITY.md': a.identityTemplate,
    'TOOLS.md': a.toolsTemplate,
  }
  if (a.agentsTemplate !== undefined) files['AGENTS.md'] = a.agentsTemplate
  return {
    listing: {
      id: a.id,
      packId: plan.id,
      slug,
      name: a.name,
      role: a.role,
      emoji: a.emoji,
      color: a.color,
      description: a.description,
      category: a.category,
      tags: a.tags,
      skillIds: a.skillIds,
      body: `agents/${slug}.json`,
      ...(a.sourceUrl ? { origin: { url: a.sourceUrl } } : {}),
      ...(a.suggestedRuntime ? { suggestedRuntime: a.suggestedRuntime } : {}),
    },
    body: { id: a.id, files },
  }
}

function teamOf(
  t: TeamTemplate,
  plan: PackPlan,
  agentsById: Map<string, AgentCatalogEntry>,
): { listing: TeamListing; body: TeamBody } {
  const id = plan.renames?.[t.id] ?? t.id
  const slug = slugOf(id, plan.idPrefix)
  const members = (t.agentIds ?? []).map((agentId) => {
    const agent = agentsById.get(agentId)
    if (!agent) throw new Error(`team "${t.id}" names "${agentId}", which is not in the catalog`)
    return { agentId, name: agent.name, role: agent.role }
  })
  return {
    listing: {
      id,
      packId: plan.id,
      slug,
      name: t.name,
      emoji: t.emoji,
      color: t.color,
      description: t.description,
      category: t.category,
      tags: t.tags,
      members,
      body: `teams/${slug}.json`,
      ...(t.sourceUrl ? { origin: { url: t.sourceUrl } } : {}),
      ...(t.defaultRuntime ? { defaultRuntime: t.defaultRuntime } : {}),
    },
    body: {
      id,
      ...(t.workflowNarrative !== undefined ? { workflowNarrative: t.workflowNarrative } : {}),
      ...(t.routing !== undefined ? { routing: t.routing } : {}),
    },
  }
}

/**
 * Pack SOURCE is hand-editable and reviewed in a pull request, so it is
 * pretty-printed rather than canonical. Only `catalog/dist/**` is canonical
 * bytes, because only those are hashed. Prettier is the final authority on this
 * formatting (the repo's pre-commit hook formats `*.json`); indenting here just
 * means the first write is already close.
 */
function writeSource(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function main(): void {
  loadConfig() // fails loudly if catalog.config.json is missing or malformed
  const agentsById = new Map(AGENT_CATALOG.map((a) => [a.id, a]))

  for (const plan of PLANS) {
    const dir = packDir(plan.ref)
    const agents = AGENT_CATALOG.filter((a) => a.packId === plan.id).map((a) => agentOf(a, plan))
    const teams = TEAM_CATALOG.filter((t) => t.packId === plan.id).map((t) =>
      teamOf(t, plan, agentsById),
    )

    const pack: AgentPack = {
      schemaVersion: 1,
      id: plan.id,
      ...(plan.idPrefix === plan.id ? {} : { idPrefix: plan.idPrefix }),
      name: plan.name,
      description: plan.description,
      version: plan.version,
      provenance: plan.provenance,
      counts: { agents: agents.length, teams: teams.length, skills: 0 },
      ...(plan.renames ? { renames: plan.renames } : {}),
      agents: agents.map((a) => a.listing),
      teams: teams.map((t) => t.listing),
      // EMPTY, DELIBERATELY. Every skill these agents reference is a Clawboo
      // BUILTIN, and `assertNoBuiltinSkillCollision` forbids a pack redeclaring
      // a builtin id (the builtin wins the merge, so the copy would be silently
      // discarded). A pack's `skills` array is for the skills it ADDS.
      skills: [],
    }

    writeSource(path.join(dir, 'pack.json'), pack)
    for (const { listing, body } of agents) writeSource(path.join(dir, listing.body), body)
    for (const { listing, body } of teams) writeSource(path.join(dir, listing.body), body)
    writeFileSync(path.join(dir, 'NOTICE.md'), plan.notice, 'utf8')

    console.log(
      `converted ${plan.id} -> ${path.relative(PACKS_DIR, dir)}: ` +
        `${agents.length} agents, ${teams.length} teams`,
    )
  }
}

main()
