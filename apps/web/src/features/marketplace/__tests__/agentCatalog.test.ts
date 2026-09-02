// Content invariants that the APP depends on, read straight off `catalog/packs`.
//
// THE FULL CONTENT GATE IS `scripts/catalog/validate.ts`, not this file. A
// content-only PR skips the whole test matrix by design, so anything that must
// hold for every pack lives there. What is here is the subset that is really a
// statement about the dashboard: names that make an @mention unambiguous,
// taxonomy values that resolve to a colour, and one acronym rule that exists
// because a machine wrote these names once and got them wrong 40 times.

import { describe, it, expect } from 'vitest'

import {
  SOURCE_AGENTS,
  SOURCE_PACKS,
  SOURCE_TEAMS,
  sourceAgentBody,
  sourceTeamBody,
} from '@/__vitest__/packSource'

import { getCatalogSkill } from '../catalog'
import { metaFor } from '../registry'

describe('the shipped agent catalog', () => {
  it('has at least 100 entries across every pack', () => {
    expect(SOURCE_AGENTS.length).toBeGreaterThanOrEqual(100)
  })

  it('has at least 90 agency-agents entries', () => {
    expect(SOURCE_AGENTS.filter((a) => a.packId === 'agency-agents').length).toBeGreaterThanOrEqual(
      90,
    )
  })

  it('has at least 15 clawboo entries', () => {
    expect(SOURCE_AGENTS.filter((a) => a.packId === 'clawboo').length).toBeGreaterThanOrEqual(15)
  })

  it('all ids are globally unique across packs', () => {
    const ids = [...SOURCE_AGENTS, ...SOURCE_TEAMS].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all names are unique, so an @mention resolves to one agent', () => {
    const names = SOURCE_AGENTS.map((a) => a.name)
    expect([...new Set(names.filter((n, i) => names.indexOf(n) !== i))]).toEqual([])
  })

  // One id prefix per pack, and no two packs sharing one, is what makes a flat
  // id globally unique. The pack format states it; this asserts the tree obeys.
  it('every pack emits one id prefix, and no two packs share a prefix', () => {
    const prefixes = SOURCE_PACKS.map((p) => p.manifest.idPrefix ?? p.manifest.id)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    const offenders: string[] = []
    for (const pack of SOURCE_PACKS) {
      const prefix = pack.manifest.idPrefix ?? pack.manifest.id
      for (const entry of [...pack.manifest.agents, ...pack.manifest.teams]) {
        if (entry.id !== `${prefix}-${entry.slug}`) {
          offenders.push(`${entry.id} is not "${prefix}-${entry.slug}"`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every agent body carries a non-empty SOUL.md, IDENTITY.md and TOOLS.md', () => {
    const missing: string[] = []
    for (const a of SOURCE_AGENTS) {
      const files = sourceAgentBody(a.id)?.files ?? {}
      for (const name of ['SOUL.md', 'IDENTITY.md', 'TOOLS.md']) {
        if ((files[name] ?? '').trim().length === 0) missing.push(`${a.id}#${name}`)
      }
    }
    expect(missing).toEqual([])
  })

  // The old assertion here was `identityTemplate.length > 500` under the banner
  // "zero-loss - full content preserved". That was a floor that enforced the
  // bloat: it blessed dumping the raw upstream file, YAML frontmatter and all,
  // into the agent's system prompt. These three are the repair, and each one
  // failed on the corpus as ingested: 179 frontmatter blocks, 138 truncations.
  it('no IDENTITY.md opens with YAML frontmatter', () => {
    const offenders = SOURCE_AGENTS.filter((a) =>
      (sourceAgentBody(a.id)?.files['IDENTITY.md'] ?? '').startsWith('---'),
    ).map((a) => a.id)
    expect(offenders).toEqual([])
  })

  it('no description is machine-truncated', () => {
    const offenders = SOURCE_AGENTS.filter((a) => a.description.trimEnd().endsWith('...')).map(
      (a) => a.id,
    )
    expect(offenders).toEqual([])
  })

  it('IDENTITY.md stays under the 50000 char prompt ceiling', () => {
    for (const a of SOURCE_AGENTS) {
      const length = (sourceAgentBody(a.id)?.files['IDENTITY.md'] ?? '').length
      expect(length, `${a.id} IDENTITY.md is ${length} chars`).toBeLessThanOrEqual(50_000)
    }
  })

  // The old ingest pass ran a naive titleCase() over slugs, which turned every
  // acronym into a proper noun: "Marketing Seo Specialist", "Design Ui Designer".
  it('no name or role carries a titleCase-mangled acronym', () => {
    const mangled =
      /\b(Ai|Api|Aso|Cms|Crm|Devops|Hf|Hr|Latex|Linkedin|Lsp|Macos|Mcp|N8n|Ppc|Qa|Rag|Seo|Sre|Tiktok|Ui|Ux|Visionos|Wechat|Xr|Zk)\b/
    const offenders = SOURCE_AGENTS.filter((a) => mangled.test(a.name) || mangled.test(a.role)).map(
      (a) => `${a.id}: ${a.name} / ${a.role}`,
    )
    expect(offenders).toEqual([])
  })

  it('no entry repeats a tag', () => {
    const offenders = SOURCE_AGENTS.filter((a) => new Set(a.tags).size !== a.tags.length).map(
      (a) => a.id,
    )
    expect(offenders).toEqual([])
  })

  // A reference resolves against the MERGED registry: the host builtins UNION
  // the declaring pack's own `skills` additions. It used to be enough to check
  // the builtins alone, because no shipped pack added any; packs do add their
  // own now, and a pack skill is visible only to the pack that declares it, so
  // the union has to be rebuilt per pack rather than flattened across them.
  // `scripts/catalog/validate.ts` is still the authoritative gate for this rule.
  it('skillIds resolve against the builtins plus the declaring pack own skills', () => {
    for (const pack of SOURCE_PACKS) {
      const own = new Set(pack.manifest.skills.map((s) => s.id))
      for (const a of pack.manifest.agents) {
        for (const id of a.skillIds) {
          const known = getCatalogSkill(id) !== undefined || own.has(id)
          expect(known, `${a.id} references unknown skillId "${id}"`).toBe(true)
        }
      }
    }
  })

  // The open category union has no compile-time exhaustiveness left, so this is
  // what replaces it: every value in use must resolve to a label and a real
  // 6-digit hex colour, because the cards append alpha suffixes to that colour
  // by string concatenation.
  it('every category in use resolves to a meta with a #RRGGBB colour', () => {
    const categories = new Set([
      ...SOURCE_AGENTS.map((a) => a.category),
      ...SOURCE_TEAMS.map((t) => t.category),
    ])
    expect(categories.size).toBeGreaterThan(0)
    for (const category of categories) {
      const meta = metaFor(category)
      expect(meta.label, `category "${category}" has no label`).toBeTruthy()
      expect(meta.color, `category "${category}" colour`).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})

// ─── Denylist ───────────────────────────────────────────────────────────────

/**
 * The catalog is prompt text that ships to the model and card text that ships to
 * the user. Neither may advertise a competing registry, a competing installer,
 * or a chat invite.
 *
 * The same regex is the shipping gate in `scripts/catalog/validate.ts`. It is
 * duplicated here rather than imported because that script lives outside the
 * app's module graph; the copy is small, and the third test below proves this
 * one is a real gate rather than a regex that matches nothing.
 *
 * BARE `openclaw` IS NOT HERE, and the reason is one real content hit: an
 * agency workflow narrative lists "OpenClaw Command Center" in a competitive
 * landscape section. That is descriptive prose about the market, not an
 * advertisement, and OpenClaw is a runtime Clawboo integrates. Recorded rather
 * than carved out of the regex: a denylist with a hidden exception is a
 * denylist nobody can read.
 */
const DENYLIST =
  /clawhub|skills\.sh|denchclaw|aionui|moltbot|clawdbot|discord\.(gg|com)|npm install -g openclaw|npx clawhub/i

function stringFields(value: unknown, at: string, out: [string, string][]): void {
  if (typeof value === 'string') {
    out.push([at, value])
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => stringFields(item, `${at}[${i}]`, out))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) stringFields(item, `${at}.${key}`, out)
  }
}

function denied(entries: unknown[]): string[] {
  const hits: string[] = []
  for (const entry of entries) {
    const id = (entry as { id?: string }).id ?? '?'
    const fields: [string, string][] = []
    stringFields(entry, id, fields)
    for (const [at, text] of fields) {
      const match = text.match(DENYLIST)
      if (match) hits.push(`${at}: ${match[0]}`)
    }
  }
  return hits
}

describe('catalog denylist', () => {
  it('no agent listing or body names a competing registry, installer, or invite', () => {
    expect(denied(SOURCE_AGENTS)).toEqual([])
    expect(denied(SOURCE_AGENTS.map((a) => sourceAgentBody(a.id)))).toEqual([])
  })

  it('no team listing or body does either, routing and workflowNarrative included', () => {
    expect(denied(SOURCE_TEAMS)).toEqual([])
    expect(denied(SOURCE_TEAMS.map((t) => sourceTeamBody(t.id)))).toEqual([])
  })

  it('is a real gate, not a regex that matches nothing', () => {
    expect(denied([{ id: 'probe', description: 'install it from clawhub' }])).toHaveLength(1)
    expect(denied([{ id: 'probe', routing: { a: 'join discord.gg/example' } }])).toHaveLength(1)
    expect(denied([{ id: 'probe', description: 'an ordinary agent description' }])).toEqual([])
  })
})
