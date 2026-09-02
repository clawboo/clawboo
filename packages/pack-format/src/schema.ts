// Runtime validation for the v1 pack shape.
//
// The zod schemas and the interfaces in `types.ts` are two spellings of one
// shape, and `src/__tests__/ladder.test.ts` asserts a parsed fixture is
// assignable to the interface so the two cannot drift silently.
//
// `catalog/schema/{pack,index}.schema.json` is the third spelling: the PUBLIC
// specification, JSON Schema 2020-12, for a third party who writes a pack
// without installing anything from this repo.

import { z } from 'zod'

import { CURRENT_SCHEMA_VERSION } from './version'

/** Six-digit hex, uppercase or lowercase. The cards append alpha suffixes. */
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

/**
 * An EXACT semver, not a range. `^1.2.3` and `1.x` describe a set of versions;
 * a pack's `version` names the one build of the content that is in the file, and
 * accepting a range here would make "which content is this" unanswerable.
 */
export const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Flat kebab-case: the id becomes a filename and a URL segment. */
export const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const nonEmpty = z.string().min(1)
const hex = z.string().regex(HEX_COLOR, 'must be a 6-digit hex colour like #3B82F6')
const kebab = z.string().regex(KEBAB, 'must be flat kebab-case')

export const skillCategoryV1 = z.enum(['code', 'web', 'data', 'comm', 'file', 'other'])

export const adaptationV1 = z.enum(['verbatim', 'adapted', 'original'])

export const entryOriginV1 = z.object({
  url: z.string().url().optional(),
  adaptation: adaptationV1.optional(),
  authors: z.array(nonEmpty).optional(),
})

export const provenanceV1 = z.object({
  sourceId: kebab,
  label: nonEmpty,
  color: hex,
  repo: z.string().url().optional(),
  ref: nonEmpty.optional(),
  license: nonEmpty,
  authors: z.array(nonEmpty).optional(),
  adaptation: adaptationV1,
  importedAt: z.string().datetime({ offset: true }),
})

export const agentListingV1 = z.object({
  id: kebab,
  packId: kebab,
  slug: kebab,
  name: nonEmpty,
  role: nonEmpty,
  emoji: nonEmpty,
  color: hex,
  description: nonEmpty,
  category: kebab,
  tags: z.array(nonEmpty),
  skillIds: z.array(kebab),
  body: nonEmpty,
  origin: entryOriginV1.optional(),
  suggestedRuntime: nonEmpty.optional(),
})

export const teamMemberRefV1 = z.object({
  agentId: kebab,
  name: nonEmpty,
  role: nonEmpty,
})

export const teamListingV1 = z.object({
  id: kebab,
  packId: kebab,
  slug: kebab,
  name: nonEmpty,
  emoji: nonEmpty,
  color: hex,
  description: nonEmpty,
  category: kebab,
  tags: z.array(nonEmpty),
  members: z.array(teamMemberRefV1),
  body: nonEmpty,
  origin: entryOriginV1.optional(),
  defaultRuntime: nonEmpty.optional(),
})

export const packSkillV1 = z.object({
  id: kebab,
  name: nonEmpty,
  description: nonEmpty,
  category: skillCategoryV1,
  tags: z.array(nonEmpty),
})

/**
 * An agent's document set.
 *
 * SOUL.md and IDENTITY.md are required. They are the two files the deploy path
 * cannot synthesize: AGENTS.md and CLAWBOO.md are built per-deploy from the team
 * topology, and TOOLS.md can be rebuilt from `skillIds`, but a missing soul or
 * identity means the agent deploys with no instructions at all.
 */
export const agentBodyV1 = z
  .object({
    id: kebab,
    files: z.record(z.string(), z.string()),
  })
  .refine((b) => typeof b.files['SOUL.md'] === 'string' && b.files['SOUL.md'].length > 0, {
    message: 'files must include a non-empty "SOUL.md"',
    path: ['files', 'SOUL.md'],
  })
  .refine((b) => typeof b.files['IDENTITY.md'] === 'string' && b.files['IDENTITY.md'].length > 0, {
    message: 'files must include a non-empty "IDENTITY.md"',
    path: ['files', 'IDENTITY.md'],
  })

export const teamBodyV1 = z.object({
  id: kebab,
  workflowNarrative: z.string().optional(),
  routing: z.record(z.string(), z.string()).optional(),
})

const packShapeV1 = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: kebab,
  idPrefix: kebab.optional(),
  name: nonEmpty,
  description: nonEmpty,
  version: z.string().regex(EXACT_SEMVER, 'must be an exact semver, not a range'),
  provenance: provenanceV1,
  counts: z.object({
    agents: z.number().int().nonnegative(),
    teams: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
  }),
  newCategories: z.array(kebab).optional(),
  renames: z.record(z.string(), z.string().nullable()).optional(),
  agents: z.array(agentListingV1),
  teams: z.array(teamListingV1),
  skills: z.array(packSkillV1),
})

/** Every cross-field invariant, applied to both the loose and strict schema. */
function withPackInvariants<T extends z.ZodTypeAny>(shape: T): z.ZodEffects<T> {
  return shape.superRefine((pack, ctx) => {
    const p = pack as z.infer<typeof packShapeV1>
    const prefix = p.idPrefix ?? p.id

    if (
      p.counts.agents !== p.agents.length ||
      p.counts.teams !== p.teams.length ||
      p.counts.skills !== p.skills.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counts'],
        message:
          `counts disagree with the arrays they describe: ` +
          `declared {agents:${p.counts.agents},teams:${p.counts.teams},skills:${p.counts.skills}}, ` +
          `actual {agents:${p.agents.length},teams:${p.teams.length},skills:${p.skills.length}}`,
      })
    }

    if (p.provenance.sourceId !== p.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance', 'sourceId'],
        message: `provenance.sourceId "${p.provenance.sourceId}" must equal the pack id "${p.id}"`,
      })
    }

    const seen = new Set<string>()
    const entries: { kind: string; id: string; slug: string; packId: string; i: number }[] = [
      ...p.agents.map((a, i) => ({ kind: 'agents', id: a.id, slug: a.slug, packId: a.packId, i })),
      ...p.teams.map((t, i) => ({ kind: 'teams', id: t.id, slug: t.slug, packId: t.packId, i })),
    ]
    for (const e of entries) {
      if (seen.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [e.kind, e.i, 'id'],
          message: `duplicate entry id "${e.id}"`,
        })
      }
      seen.add(e.id)
      if (e.packId !== p.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [e.kind, e.i, 'packId'],
          message: `packId "${e.packId}" must equal the pack id "${p.id}"`,
        })
      }
      if (e.id !== `${prefix}-${e.slug}`) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [e.kind, e.i, 'id'],
          message: `id must be "${prefix}-${e.slug}" (idPrefix + slug), got "${e.id}"`,
        })
      }
    }

    const agentIds = new Set(p.agents.map((a) => a.id))
    for (const [i, team] of p.teams.entries()) {
      for (const [j, member] of team.members.entries()) {
        if (!agentIds.has(member.agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['teams', i, 'members', j, 'agentId'],
            message: `team "${team.id}" names "${member.agentId}", which is not an agent in this pack`,
          })
        }
      }
    }

    // NO SKILL-REFERENCE CHECK HERE, AND THAT IS DELIBERATE.
    //
    // An agent's `skillIds` resolve against the MERGED registry — the host's
    // builtin skills plus whatever this pack ADDS (`buildSkillRegistry` in
    // `apps/web/src/features/marketplace/catalog.ts`). A pack's own `skills`
    // array is the additions, not the whole vocabulary: every first-party entry
    // references Clawboo builtins, and a pack may not redeclare a builtin id
    // (`assertNoBuiltinSkillCollision` — the builtin wins the merge, so the copy
    // would be silently discarded).
    //
    // A pack-scoped version of this check therefore rejects exactly the packs it
    // should accept. pack-format cannot see the host registry, so the check
    // lives where the registry does: `scripts/catalog/validate.ts` for in-repo
    // content, `buildSkillRegistry` at runtime.
  })
}

/**
 * The v1 pack schema.
 *
 * Unknown keys are STRIPPED here and REJECTED by `agentPackV1Strict`. The loose
 * form is what a reader uses (a pack written against a later minor spec must
 * still load), the strict form is what the repo gate uses (a typo'd key in a
 * first-party pack is a bug, not forward compatibility).
 */
export const agentPackV1 = withPackInvariants(packShapeV1)

export const agentPackV1Strict = withPackInvariants(packShapeV1.strict())
