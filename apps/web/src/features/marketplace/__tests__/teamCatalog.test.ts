// Two kinds of assertion live here, and they read from different places on purpose.
//
//   SOURCE invariants (roster shape, non-empty bodies, @mention integrity) read
//   `catalog/packs/**` off disk with `fs`. That is where the content actually is
//   now that it is JSON packs rather than TypeScript modules.
//
//   LOOKUP behaviour (search, filters, getters) runs against the COMMITTED
//   `catalog/dist/v1/index.json` - the very bytes `/api/catalog/index` serves -
//   so the functions are exercised on exactly what the app receives.

import fs from 'node:fs'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

import { CATALOG_INDEX_FILE } from '@/__vitest__/catalogFixtures'
import {
  SOURCE_PACKS,
  SOURCE_TEAMS,
  routingFor,
  sourceAgent,
  sourceAgentBody,
} from '@/__vitest__/packSource'

import type { CatalogIndex } from '../catalogTypes'
import { KNOWN_PACK_META, metaFor, sourceMetaFor } from '../registry'
import {
  getTeamTemplate,
  getTemplatesByCategory,
  getTemplatesBySource,
  searchTeamCatalog,
} from '../teamCatalog'
import { packFilterEntries, teamCategoryOptions } from '../TeamShowcaseGrid'

const index = JSON.parse(fs.readFileSync(CATALOG_INDEX_FILE, 'utf8')) as CatalogIndex

/**
 * The packs this repo ships. NOT an exhaustive list of what `TemplateSource`
 * permits - that union is open, so there is no such list to write. This names
 * what is in the tree, which is a content assertion rather than a type one.
 */
const SHIPPED_PACKS = [
  'clawboo',
  'clawboo-home',
  'agency-agents',
  'voltagent-subagents',
  'wshobson-agents',
  'coreyhaines-growth-marketing',
  'clawboo-founder-sprint',
  'mattpocock-craft',
  'agricidaniel-repurpose',
  'alirezarezvani-business-desk',
  'blackforestlabs-visual-direction',
  'calesthio-generative-media',
  'charliehills-creator-studio',
  'craighewitt-creator-ops',
  'google-ads-analytics',
  'heygen-presenter-video',
  'kgelster-storefront-catalog',
  'phuryn-product-craft',
  'thatrebeccarae-lifecycle-commerce',
]

describe('the shipped team catalog', () => {
  it('has at least 10 templates across all packs', () => {
    expect(SOURCE_TEAMS.length).toBeGreaterThanOrEqual(10)
  })

  it('all ids are unique', () => {
    const ids = SOURCE_TEAMS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('each template has a category and a shipped packId', () => {
    for (const t of SOURCE_TEAMS) {
      expect(t.category, `${t.id} missing category`).toBeTruthy()
      expect(SHIPPED_PACKS, `${t.id} has unknown packId "${t.packId}"`).toContain(t.packId)
    }
  })

  it('every member resolves to an agent with non-empty SOUL, IDENTITY and TOOLS', () => {
    for (const t of SOURCE_TEAMS) {
      expect(t.members.length, `team ${t.id} has zero agents`).toBeGreaterThan(0)
      for (const member of t.members) {
        const files = sourceAgentBody(member.agentId)?.files
        expect(files, `team ${t.id} names missing agent ${member.agentId}`).toBeDefined()
        for (const name of ['SOUL.md', 'IDENTITY.md', 'TOOLS.md']) {
          expect((files?.[name] ?? '').length, `${member.agentId}#${name}`).toBeGreaterThan(0)
        }
      }
    }
  })

  // A denormalised member row that disagrees with the agent it names is worse
  // than no row at all: the card renders one name and the deploy writes another.
  it('denormalised member name and role match the agent listing', () => {
    const drift: string[] = []
    for (const t of SOURCE_TEAMS) {
      for (const member of t.members) {
        const agent = sourceAgent(member.agentId)
        if (!agent) continue
        if (agent.name !== member.name || agent.role !== member.role) {
          drift.push(`${t.id} -> ${member.agentId}`)
        }
      }
    }
    expect(drift).toEqual([])
  })

  it('AGENTS.md @mentions reference valid agent names within the same template', () => {
    const mentionRegex = /@([\w][\w ._-]{0,60})/g
    for (const t of SOURCE_TEAMS) {
      const agentNames = t.members.map((m) => m.name)
      for (const member of t.members) {
        const agentsMd = routingFor(t.id, member.agentId)
        if (!agentsMd) continue
        for (const match of agentsMd.matchAll(mentionRegex)) {
          const trimmed = (match[1] ?? '').trim()
          expect(
            agentNames.some((name) => name.startsWith(trimmed) || trimmed.startsWith(name)),
            `${t.id}#${member.agentId} mentions "@${trimmed}"`,
          ).toBe(true)
        }
      }
    }
  })

  // Held back until the generated hub-and-spoke teams were removed, since they
  // would have failed it wholesale. A "team" of one is a solo agent wearing a
  // team's clothes; browse-by-agent covers that case properly.
  it('every team has at least two members', () => {
    const solo = SOURCE_TEAMS.filter((t) => t.members.length < 2).map(
      (t) => `${t.id} (${t.members.length})`,
    )
    expect(solo).toEqual([])
  })

  it('has no duplicate team names', () => {
    const names = SOURCE_TEAMS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every template has description, tags, emoji, and color', () => {
    for (const t of SOURCE_TEAMS) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.tags.length).toBeGreaterThan(0)
      expect(t.emoji.length).toBeGreaterThan(0)
      expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  // The five builtin team ids gained their pack prefix when the catalog became
  // packs (`dev` -> `clawboo-dev`). A rename that is not recorded is a rename a
  // stored `templateId` can never be reconciled against.
  it('records every id it renamed', () => {
    const clawboo = SOURCE_PACKS.find((p) => p.manifest.id === 'clawboo')
    const renames = Object.entries(clawboo?.manifest.renames ?? {})
    expect(renames).not.toHaveLength(0)
    for (const [from, to] of renames) {
      expect(from, 'a rename must actually change the id').not.toBe(to)
      if (to !== null) {
        expect(
          SOURCE_TEAMS.some((t) => t.id === to),
          `rename target "${to}" does not exist`,
        ).toBe(true)
      }
    }
  })
})

describe('the committed index', () => {
  it('is the file the API serves, and it is not empty', () => {
    expect(fs.existsSync(CATALOG_INDEX_FILE), path.basename(CATALOG_INDEX_FILE)).toBe(true)
    expect(index.counts.agents).toBeGreaterThan(0)
    expect(index.counts.teams).toBeGreaterThan(0)
  })
})

describe('searchTeamCatalog', () => {
  it('returns empty for no matches', () => {
    expect(searchTeamCatalog(index, 'zzz-nonexistent-query-xyz')).toEqual([])
  })

  it('returns full catalog for empty query', () => {
    expect(searchTeamCatalog(index, '')).toBe(index.teams)
  })

  it('finds templates by tag', () => {
    expect(searchTeamCatalog(index, 'seo').length).toBeGreaterThan(0)
  })

  it('returns results for common search terms', () => {
    for (const term of ['marketing', 'dev', 'ai', 'workflow', 'sprint', 'content']) {
      expect(searchTeamCatalog(index, term).length, term).toBeGreaterThan(0)
    }
  })
})

describe('getTeamTemplate', () => {
  it('returns undefined for unknown ID', () => {
    expect(getTeamTemplate(index, 'nonexistent-id')).toBeUndefined()
  })

  it('finds template by ID', () => {
    const t = getTeamTemplate(index, 'clawboo-marketing')
    expect(t).toBeDefined()
    expect(t!.name).toBe('Marketing Squad')
  })
})

describe('getTemplatesByCategory', () => {
  it('finds product templates', () => {
    expect(getTemplatesByCategory(index, 'product').length).toBeGreaterThanOrEqual(1)
  })

  it('finds content templates', () => {
    expect(getTemplatesByCategory(index, 'content').length).toBeGreaterThanOrEqual(1)
  })

  it('finds templates by category', () => {
    expect(getTemplatesByCategory(index, 'marketing').length).toBeGreaterThan(0)
  })
})

describe('getTemplatesBySource', () => {
  it('finds builtin templates', () => {
    expect(getTemplatesBySource(index, 'clawboo').length).toBeGreaterThanOrEqual(5)
  })

  it('finds agency-agents templates', () => {
    expect(getTemplatesBySource(index, 'agency-agents').length).toBeGreaterThanOrEqual(5)
  })
})

// `TEMPLATE_CATEGORIES` and `SOURCE_META` were exhaustive maps over closed
// unions, and the tests here asserted they had an entry for every union member.
// Neither the maps nor that assertion can exist over an open union.
//
// What replaces them is the only statement that is still both true and useful:
// every value the LOADED INDEX actually contains resolves to a label and a real
// 6-digit hex colour. That is the property the UI depends on - the cards build
// alpha variants by concatenating onto the colour, so a non-hex value renders
// transparent and an undefined one white-screens the tab.
describe('open-union display metadata', () => {
  const HEX = /^#[0-9A-Fa-f]{6}$/

  it('every category in the index resolves to a meta with a #RRGGBB colour', () => {
    const categories = new Set([
      ...index.agents.map((a) => a.category),
      ...index.teams.map((t) => t.category),
    ])
    expect(categories.size).toBeGreaterThan(0)
    for (const category of categories) {
      const meta = metaFor(category)
      expect(meta.label, `category "${category}" has no label`).toBeTruthy()
      expect(meta.color, `category "${category}"`).toMatch(HEX)
    }
  })

  it('every packId in the index resolves to a meta with a #RRGGBB colour', () => {
    const packs = new Set([
      ...index.agents.map((a) => a.packId),
      ...index.teams.map((t) => t.packId),
    ])
    expect(packs.size).toBeGreaterThan(0)
    for (const packId of packs) {
      const meta = sourceMetaFor(packId)
      expect(meta.label, `pack "${packId}" has no label`).toBeTruthy()
      expect(meta.color, `pack "${packId}"`).toMatch(HEX)
    }
  })

  // The fallback keeps an unknown pack safe, but it is not good enough for a
  // pack this repo actually ships: `derive` title-cases the id, so a forgotten
  // entry renders a filter pill reading "Mattpocock Craft" instead of the label
  // the pack manifest declares. Every shipped pack must be a KNOWN one.
  it('every shipped pack has an explicit KNOWN_PACK_META entry', () => {
    const missing = SHIPPED_PACKS.filter((packId) => !(packId in KNOWN_PACK_META))
    expect(missing, 'add these to KNOWN_PACK_META in registry.ts').toEqual([])
  })

  // The label and colour are not free-form: they come from the pack manifest, so
  // a pill can never disagree with the pack it filters to. Two manifest fields
  // are legitimate label sources - the pack's own `name` and the shorter
  // `provenance.label` - and a pack may use either, but nothing else.
  it('each KNOWN_PACK_META entry matches a manifest label and the provenance colour', () => {
    const drift: string[] = []
    for (const { manifest } of SOURCE_PACKS) {
      const meta = KNOWN_PACK_META[manifest.id]
      if (!meta) continue
      const allowed = [manifest.name, manifest.provenance.label]
      if (!allowed.includes(meta.label)) {
        drift.push(`${manifest.id} label "${meta.label}" is not one of ${allowed.join(' / ')}`)
      }
      if (meta.color !== manifest.provenance.color) {
        drift.push(`${manifest.id} color ${meta.color} != ${manifest.provenance.color}`)
      }
    }
    expect(drift).toEqual([])
  })

  // An id nobody has ever shipped. The fallback is what makes the open union
  // safe, so it is asserted directly rather than only through known values.
  it('an entirely unknown value still resolves, with a hex colour', () => {
    const meta = metaFor('quantum-cartography')
    expect(meta.label).toBe('Quantum Cartography')
    expect(meta.color).toMatch(HEX)
    expect(sourceMetaFor('some-third-party-pack').color).toMatch(HEX)
  })

  it('is deterministic, so an unknown category keeps its colour across reloads', () => {
    expect(metaFor('quantum-cartography')).toEqual(metaFor('quantum-cartography'))
  })
})

describe('derived filter options', () => {
  it('offers a category pill for every category present, and none that is not', () => {
    const present = new Set(index.teams.map((t) => t.category))
    const keys = teamCategoryOptions(index).map((o) => o.key)
    expect(new Set(keys)).toEqual(present)
  })

  it('orders category pills by team count, busiest first', () => {
    const counts = new Map<string, number>()
    for (const t of index.teams) counts.set(t.category, (counts.get(t.category) ?? 0) + 1)
    const keys = teamCategoryOptions(index).map((o) => o.key)
    for (let i = 1; i < keys.length; i++) {
      expect(counts.get(keys[i - 1]!) ?? 0).toBeGreaterThanOrEqual(counts.get(keys[i]!) ?? 0)
    }
  })

  it("offers 'All' plus one pack pill per pack in the index", () => {
    const entries = packFilterEntries(index)
    expect(entries[0]!.key).toBe('all')
    const packs = new Set([...index.teams, ...index.agents].map((e) => e.packId))
    expect(new Set(entries.slice(1).map((e) => e.key))).toEqual(packs)
  })
})
