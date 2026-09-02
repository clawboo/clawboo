// The version ladder, exercised through its fixtures.
//
// FIXTURES ARE APPEND-ONLY. Editing `v1/minimal.json` to make a test pass is
// exactly how a ladder silently stops covering the shape it claims to: the
// fixture is the frozen record of what v1 looked like, and a v2 that can no
// longer read it is a v2 that broke compatibility. Add a file, never rewrite one.

import { describe, expect, it } from 'vitest'

import invalidMissingVersion from '../__fixtures__/invalid/missing-version.json'
import invalidStringVersion from '../__fixtures__/invalid/string-version.json'
import invalidTooNew from '../__fixtures__/invalid/too-new.json'
import invalidBadShape from '../__fixtures__/invalid/v1-bad-shape.json'
import kitchenSink from '../__fixtures__/v1/kitchen-sink.json'
import minimal from '../__fixtures__/v1/minimal.json'
import { DEFAULT_LADDER, STRICT_LADDER, parseAgentPack, runUpgrades, type Ladder } from '../parse'
import { agentBodyV1, agentPackV1 } from '../schema'
import { KNOWN_SCHEMA_VERSIONS, SCHEMAS, STRICT_SCHEMAS, UPGRADES, type Upgrade } from '../registry'
import type { AgentPack } from '../types'
import { CURRENT_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION, SUPPORTED_RANGE } from '../version'

/** Shallow clone that JSON fixtures can be mutated through without cross-test leakage. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('the version window', () => {
  it('is a single version at v1', () => {
    expect(MIN_SUPPORTED_SCHEMA_VERSION).toBe(1)
    expect(CURRENT_SCHEMA_VERSION).toBe(1)
    expect(SUPPORTED_RANGE).toBe('1..1')
  })

  it('has a validator for every version in the window', () => {
    for (let v = MIN_SUPPORTED_SCHEMA_VERSION; v <= CURRENT_SCHEMA_VERSION; v++) {
      expect(SCHEMAS[v as keyof typeof SCHEMAS], `no schema for v${v}`).toBeDefined()
      expect(STRICT_SCHEMAS[v as keyof typeof STRICT_SCHEMAS], `no strict schema`).toBeDefined()
    }
    expect(KNOWN_SCHEMA_VERSIONS).toEqual([1])
  })

  // The empty map is the design, not an oversight: there is one version, so
  // there is nothing to upgrade. A no-op entry here would make the self-check in
  // `parseAgentPack` pass vacuously.
  it('has an empty upgrade chain, because there is nothing to upgrade yet', () => {
    expect(Object.keys(UPGRADES)).toEqual([])
  })
})

describe('parseAgentPack: valid fixtures', () => {
  it('accepts the minimal v1 pack', () => {
    const result = parseAgentPack(minimal)
    expect(result.ok, result.ok ? '' : result.message).toBe(true)
    if (!result.ok) return
    expect(result.pack.id).toBe('clawboo')
    expect(result.declaredVersion).toBe(1)
    expect(result.warnings).toEqual([])
  })

  it('accepts the kitchen-sink v1 pack, every optional field set', () => {
    const result = parseAgentPack(kitchenSink)
    expect(result.ok, result.ok ? '' : result.message).toBe(true)
    if (!result.ok) return
    // A parsed pack is assignable to the interface: this is what keeps the zod
    // schema and `types.ts` from drifting into two different shapes.
    const pack: AgentPack = result.pack
    expect(pack.idPrefix).toBe('agency')
    expect(pack.newCategories).toEqual(['localization'])
    expect(pack.renames?.['agency-retired-bot']).toBeNull()
    expect(pack.agents[0]?.origin?.adaptation).toBe('adapted')
    expect(pack.teams[0]?.members).toHaveLength(2)
  })

  it('accepts an idPrefix that differs from the pack id', () => {
    const result = parseAgentPack(kitchenSink)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const agent of result.pack.agents) {
      expect(agent.id).toBe(`agency-${agent.slug}`)
      expect(agent.packId).toBe('agency-agents')
    }
  })

  it('strips unknown keys by default and rejects them under the strict ladder', () => {
    const withExtra = { ...clone(minimal), somethingNew: 'from a later spec' }
    const loose = parseAgentPack(withExtra)
    expect(loose.ok).toBe(true)
    if (loose.ok) expect('somethingNew' in loose.pack).toBe(false)

    const strict = parseAgentPack(withExtra, { ladder: STRICT_LADDER })
    expect(strict.ok).toBe(false)
    if (!strict.ok) expect(strict.code).toBe('invalid-at-declared-version')
  })
})

describe('parseAgentPack: the six reject paths', () => {
  it('missing-schema-version, and never defaults to 1', () => {
    const result = parseAgentPack(invalidMissingVersion)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('missing-schema-version')
    expect(result.declaredVersion).toBeNull()
    expect(result.message).toMatch(/schemaVersion/)
  })

  it('missing-schema-version for a non-object document', () => {
    for (const raw of [null, 'a pack', 42, [1, 2, 3]]) {
      const result = parseAgentPack(raw)
      expect(result.ok, JSON.stringify(raw)).toBe(false)
      if (!result.ok) expect(result.code).toBe('missing-schema-version')
    }
  })

  it('schema-version-not-an-integer for a string version', () => {
    const result = parseAgentPack(invalidStringVersion)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('schema-version-not-an-integer')
    expect(result.message).toMatch(/INTEGER/)
  })

  it('schema-version-not-an-integer for a fractional version', () => {
    const result = parseAgentPack({ ...clone(minimal), schemaVersion: 1.5 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('schema-version-not-an-integer')
  })

  it('schema-version-too-new names the range and points at the upgrade', () => {
    const result = parseAgentPack(invalidTooNew)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('schema-version-too-new')
    expect(result.declaredVersion).toBe(2)
    expect(result.message).toContain(SUPPORTED_RANGE)
    expect(result.message).toMatch(/Upgrade Clawboo/)
  })

  it('schema-version-too-old tells the author to re-publish', () => {
    const result = parseAgentPack({ ...clone(minimal), schemaVersion: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('schema-version-too-old')
    expect(result.message).toMatch(/Re-publish the pack at schemaVersion 1/)
  })

  it('invalid-at-declared-version reports issues against the shape the author wrote', () => {
    const result = parseAgentPack(invalidBadShape)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid-at-declared-version')
    expect(result.declaredVersion).toBe(1)
    const paths = result.issues.map((i) => i.path)
    expect(paths).toContain('version')
    expect(paths).toContain('agents.0.color')
    expect(paths).toContain('agents.0.id')
  })

  // The self-check after the upgrade chain. `UPGRADES` is empty, so the only
  // honest way to exercise it is with a ladder whose chain really does produce a
  // broken document — which is what the real one must never do.
  it('upgrade-produced-invalid-document when a chain corrupts the document', () => {
    const breakIt: Upgrade = (doc) => ({ ...doc, schemaVersion: 2, id: 'NOT KEBAB' })
    const twoStepLadder: Ladder = {
      schemas: { 1: agentPackV1, 2: agentPackV1 },
      upgrades: { 1: breakIt },
      min: 1,
      current: 2,
    }
    const result = parseAgentPack(
      { ...clone(minimal), schemaVersion: 1 },
      { ladder: twoStepLadder },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('upgrade-produced-invalid-document')
    expect(result.message).toMatch(/The upgrade chain is wrong, not the pack/)
  })
})

describe('staleVersionPolicy', () => {
  // Two versions, no upgrade needed (v2 accepts the v1 shape): enough to make a
  // v1 document "stale but readable", which is impossible against the real ladder.
  const twoVersions: Ladder = {
    schemas: { 1: agentPackV1, 2: agentPackV1 },
    upgrades: {},
    min: 1,
    current: 2,
  }
  const stale = () => clone(minimal)

  it('DEFAULTS TO allow, so a call site that forgets it permits stale content', () => {
    const result = parseAgentPack(stale(), { ladder: twoVersions })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toEqual([])
  })

  it('warn loads the pack and reports it', () => {
    const result = parseAgentPack(stale(), { ladder: twoVersions, staleVersionPolicy: 'warn' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings.join(' ')).toMatch(/schema 1; the current version is 2/)
  })

  it('error rejects it', () => {
    const result = parseAgentPack(stale(), { ladder: twoVersions, staleVersionPolicy: 'error' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('schema-version-too-old')
  })

  it('does not fire at all when the declared version is current', () => {
    const result = parseAgentPack(minimal, { staleVersionPolicy: 'error' })
    expect(result.ok).toBe(true)
  })
})

describe('runUpgrades', () => {
  it('is a no-op against the real, empty chain', () => {
    const doc = { schemaVersion: 1 }
    const out = runUpgrades(doc, 1, 1, DEFAULT_LADDER.upgrades)
    expect(out.applied).toEqual([])
    expect(out.doc).toBe(doc)
  })

  it('applies each step in order', () => {
    const upgrades: Record<number, Upgrade> = {
      1: (d) => ({ ...d, schemaVersion: 2, seen: ['v1'] }),
      2: (d) => ({ ...d, schemaVersion: 3, seen: [...(d.seen as string[]), 'v2'] }),
    }
    const out = runUpgrades({ schemaVersion: 1 }, 1, 3, upgrades)
    expect(out.applied).toEqual([1, 2])
    expect(out.doc).toEqual({ schemaVersion: 3, seen: ['v1', 'v2'] })
  })

  it('stops at the first missing step rather than skipping it', () => {
    const upgrades: Record<number, Upgrade> = { 1: (d) => ({ ...d, schemaVersion: 2 }) }
    const out = runUpgrades({ schemaVersion: 1 }, 1, 4, upgrades)
    expect(out.applied).toEqual([1])
  })
})

describe('pack invariants', () => {
  it('rejects counts that disagree with the arrays', () => {
    const doc = clone(minimal)
    doc.counts.agents = 7
    const result = parseAgentPack(doc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((i) => i.path)).toContain('counts')
  })

  it('rejects a team member that is not an agent in the pack', () => {
    const doc = clone(kitchenSink)
    doc.teams[0].members[0].agentId = 'agency-nobody'
    const result = parseAgentPack(doc)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map((i) => i.path)).toContain('teams.0.members.0.agentId')
    }
  })

  // The inverse of the team-member rule above, and the asymmetry is the point.
  // A member id names an entry of THIS pack, so the pack can check it alone. A
  // skillId resolves against the MERGED registry — host builtins plus whatever
  // this pack adds — and a pack may not redeclare a builtin, so every
  // first-party entry references ids its own `skills` array does not contain.
  // Rejecting here would reject exactly the packs that are correct; the check
  // lives with the registry instead (scripts/catalog/validate.ts in-repo,
  // buildSkillRegistry at runtime).
  it('accepts a skillId the pack does not define, because it may be a host builtin', () => {
    const doc = clone(kitchenSink)
    doc.agents[1].skillIds = ['web-search']
    expect(parseAgentPack(doc).ok).toBe(true)
  })

  it('rejects a semver RANGE where an exact version is required', () => {
    for (const version of ['^1.2.3', '1.x', '~2.0.0', '>=1.0.0']) {
      const doc = { ...clone(minimal), version }
      const result = parseAgentPack(doc)
      expect(result.ok, version).toBe(false)
    }
  })

  it('accepts a prerelease and build-metadata semver', () => {
    const doc = { ...clone(minimal), version: '1.2.3-rc.1+build.7' }
    expect(parseAgentPack(doc).ok).toBe(true)
  })

  it('requires a 6-digit hex colour, because the cards append alpha to it', () => {
    for (const color of ['blue', '#FFF', 'hsl(210 62% 55%)', '#3B82F6FF']) {
      const doc = clone(minimal)
      doc.agents[0].color = color
      expect(parseAgentPack(doc).ok, color).toBe(false)
    }
  })

  it('rejects duplicate entry ids across agents and teams', () => {
    const doc = clone(kitchenSink)
    doc.teams[0].slug = 'qa-engineer'
    doc.teams[0].id = 'agency-qa-engineer'
    const result = parseAgentPack(doc)
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.issues.some((i) => /duplicate entry id/.test(i.message))).toBe(true)
  })
})

describe('agentBodyV1', () => {
  it('accepts a body with the two required files', () => {
    const parsed = agentBodyV1.safeParse({
      id: 'clawboo-research-boo',
      files: { 'SOUL.md': '# SOUL\n', 'IDENTITY.md': '# IDENTITY\n' },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a body missing SOUL.md or IDENTITY.md', () => {
    const noSoul = agentBodyV1.safeParse({
      id: 'clawboo-research-boo',
      files: { 'IDENTITY.md': '# IDENTITY\n' },
    })
    expect(noSoul.success).toBe(false)
    const noIdentity = agentBodyV1.safeParse({
      id: 'clawboo-research-boo',
      files: { 'SOUL.md': '# SOUL\n' },
    })
    expect(noIdentity.success).toBe(false)
  })

  it('accepts extra files, because the map is the point', () => {
    const parsed = agentBodyV1.safeParse({
      id: 'clawboo-research-boo',
      files: {
        'SOUL.md': '# SOUL\n',
        'IDENTITY.md': '# IDENTITY\n',
        'TOOLS.md': '# TOOLS\n',
        'PLAYBOOK.md': '# PLAYBOOK\n',
      },
    })
    expect(parsed.success).toBe(true)
  })
})
