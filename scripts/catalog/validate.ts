#!/usr/bin/env tsx
/**
 * The content gate for `catalog/`. One command, every rule.
 *
 * WHY IT IS ONE SCRIPT AND NOT FIVE. A content-only PR does not run the app's
 * test matrix - that is the entire point of the CI split - so any rule that
 * lives only in a vitest file is a rule a content PR can violate silently. Every
 * content invariant therefore lives here, in the script `catalog-ci.yml` runs.
 * The unit tests keep the rules that are about how the APP consumes the catalog;
 * these are about whether the catalog is fit to ship.
 *
 * It absorbs the retired `scripts/scan-catalog-injection.ts` wholesale, and for
 * the same reason it gave: the scan runs over PARSED entries, never over source
 * text. Reading pack bodies as raw file bytes would put a rule's `\s+` across
 * the boundary between one entry and the next, which manufactured 48 cross-line
 * false positives during research.
 *
 * Exit codes: 0 clean, 1 on any failure.
 *
 * Usage:
 *   tsx scripts/catalog/validate.ts
 *   tsx scripts/catalog/validate.ts --update-allowlist
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  BUILTIN_SKILLS,
  assertNoBuiltinSkillCollision,
} from '../../apps/web/src/features/marketplace/catalog.ts'
import { isKnownCategory } from '../../apps/web/src/features/marketplace/registry.ts'
// Imported from source, not from `@clawboo/db`: the repo root has no dependency
// on the workspace package, and `injection.ts` pulls in nothing but node:crypto.
import { evaluateInjection } from '../../packages/db/src/tools/injection.ts'
import {
  STRICT_LADDER,
  agentBodyV1,
  parseAgentPack,
  teamBodyV1,
  type AgentPack,
} from '../../packages/pack-format/src/index.ts'
import {
  CATALOG_INJECTION_ALLOWLIST,
  type CatalogInjectionAllowlistEntry,
} from './injection-allowlist.ts'
import { REPO_ROOT, loadAllPacks, loadConfig, type LoadedPack } from './lib/packs.ts'

const ALLOWLIST_FILE = path.join(REPO_ROOT, 'scripts/catalog/injection-allowlist.ts')

/**
 * The catalog is prompt text that ships to the model and card text that ships to
 * the user. Neither may advertise a competing registry, a competing installer,
 * or a chat invite.
 *
 * BARE `openclaw` IS NOT HERE, deliberately: OpenClaw is a runtime Clawboo
 * integrates, and one agency workflow narrative names it in a competitive
 * landscape section. That is descriptive prose about the market, not an
 * advertisement. Recorded here rather than carved out of the regex, because a
 * denylist with a hidden exception is a denylist nobody can read.
 */
const DENYLIST =
  /clawhub|skills\.sh|denchclaw|aionui|moltbot|clawdbot|discord\.(gg|com)|npm install -g openclaw|npx clawhub/i

/** The prompt ceiling an agent body must stay under. */
const IDENTITY_MAX_CHARS = 50_000

const problems: string[] = []
const note = (where: string, message: string): void => {
  problems.push(`${where}: ${message}`)
}

// ─── Walkers ─────────────────────────────────────────────────────────────────

/** Every string in a value, with a dotted path to it. */
function stringFields(value: unknown, at: string, out: [string, string][]): void {
  if (typeof value === 'string') {
    out.push([at, value])
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => stringFields(item, `${at}[${i}]`, out))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) stringFields(item, `${at}.${key}`, out)
  }
}

interface Chunk {
  scope: string
  text: string
}

/**
 * The scannable prose of one pack: the fields a deploy writes into an agent's
 * files, plus the card text a user reads. The scope spelling
 * (`<entry id>#<file>`) is load-bearing - it is half of every allowlist
 * fingerprint, so changing it silently invalidates every reviewed suppression.
 */
function chunksOf(loaded: LoadedPack, pack: AgentPack): Chunk[] {
  const out: Chunk[] = []
  const push = (scope: string, text: string | undefined): void => {
    if (typeof text === 'string' && text.length > 0) out.push({ scope, text })
  }
  for (const a of pack.agents) {
    push(`${a.id}#name`, a.name)
    push(`${a.id}#role`, a.role)
    push(`${a.id}#description`, a.description)
    const body = loaded.agentBodies.get(a.id)
    for (const [file, text] of Object.entries(body?.files ?? {})) push(`${a.id}#${file}`, text)
  }
  for (const t of pack.teams) {
    push(`${t.id}#name`, t.name)
    push(`${t.id}#description`, t.description)
    const body = loaded.teamBodies.get(t.id)
    push(`${t.id}#workflowNarrative`, body?.workflowNarrative)
    for (const [agentId, text] of Object.entries(body?.routing ?? {})) {
      push(`${t.id}#AGENTS.md:${agentId}`, text)
    }
  }
  return out
}

// ─── Structural rules ────────────────────────────────────────────────────────

function checkPackStructure(loaded: LoadedPack): AgentPack | null {
  const where = path.relative(REPO_ROOT, loaded.dir)
  const result = parseAgentPack(loaded.pack, {
    ladder: STRICT_LADDER,
    staleVersionPolicy: 'error',
  })
  if (!result.ok) {
    note(`${where}/pack.json`, `${result.code}: ${result.message}`)
    for (const issue of result.issues) {
      note(`${where}/pack.json`, `  ${issue.path}: ${issue.message}`)
    }
    return null
  }
  const pack = result.pack

  // Licence and attribution. A pack that names an upstream repository must carry
  // the notice that upstream's licence requires; the SPDX id alone is a claim
  // with nothing behind it.
  if (pack.provenance.repo && loaded.notice === null) {
    note(where, 'provenance.repo is set but the pack ships no NOTICE.md')
  }
  if (loaded.notice !== null && loaded.notice.trim().length === 0) {
    note(where, 'NOTICE.md is empty')
  }

  // Bodies: one file per listing, no orphans, and each one valid on its own.
  const declared = new Set<string>()
  const agentIds = new Set(pack.agents.map((a) => a.id))
  for (const listing of [...pack.agents, ...pack.teams]) {
    declared.add(path.join(loaded.dir, listing.body))
    const isAgent = agentIds.has(listing.id)
    const body = isAgent ? loaded.agentBodies.get(listing.id) : loaded.teamBodies.get(listing.id)
    if (!body) {
      note(
        where,
        `"${listing.id}" declares body ${listing.body}, which is missing or carries a different id`,
      )
      continue
    }
    const parsed = (isAgent ? agentBodyV1 : teamBodyV1).safeParse(body)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        note(`${where}/${listing.body}`, `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      }
    }
  }
  for (const dir of ['agents', 'teams']) {
    const full = path.join(loaded.dir, dir)
    if (!existsSync(full)) continue
    for (const file of readdirSync(full)) {
      if (!file.endsWith('.json')) continue
      if (!declared.has(path.join(full, file))) {
        note(where, `${dir}/${file} is not referenced by any listing (orphan body)`)
      }
    }
  }

  // Skills. A pack's `skills` array is what it ADDS; references resolve against
  // the merged registry, and redeclaring a builtin would be silently discarded.
  try {
    assertNoBuiltinSkillCollision(pack.skills)
  } catch (err) {
    note(where, err instanceof Error ? err.message : String(err))
  }
  const knownSkills = new Set([...BUILTIN_SKILLS.map((s) => s.id), ...pack.skills.map((s) => s.id)])
  for (const a of pack.agents) {
    for (const id of a.skillIds) {
      if (!knownSkills.has(id)) {
        note(where, `"${a.id}" references skill "${id}", which nothing defines`)
      }
    }
  }

  // Taxonomy. A category the host ships no label for must be declared, which is
  // what turns a new filter chip into a reviewable line in the content PR.
  const usedCategories = new Set([
    ...pack.agents.map((a) => a.category),
    ...pack.teams.map((t) => t.category),
  ])
  const announced = new Set(pack.newCategories ?? [])
  for (const category of usedCategories) {
    if (!isKnownCategory(category) && !announced.has(category)) {
      note(where, `category "${category}" is unknown to the host and not declared in newCategories`)
    }
  }
  for (const category of announced) {
    if (isKnownCategory(category)) {
      note(where, `newCategories lists "${category}", which the host already ships a label for`)
    } else if (!usedCategories.has(category)) {
      note(where, `newCategories lists "${category}", which no entry in this pack uses`)
    }
  }

  return pack
}

// ─── Content rules ───────────────────────────────────────────────────────────

function checkContent(loaded: LoadedPack, pack: AgentPack): void {
  const where = path.relative(REPO_ROOT, loaded.dir)

  for (const a of pack.agents) {
    // A description ending in an ellipsis is a machine truncation, not a
    // sentence. 138 of them shipped once; this gate is what keeps them out.
    if (a.description.trimEnd().endsWith('...')) {
      note(where, `"${a.id}" description is machine-truncated`)
    }
    if (a.description.trim().length < 20) {
      note(where, `"${a.id}" description is too short to be useful`)
    }
    const identity = loaded.agentBodies.get(a.id)?.files['IDENTITY.md'] ?? ''
    // The catalog stores the frontmatter fields structurally, so a body that
    // still opens with a YAML block is an unconverted upstream file.
    if (identity.startsWith('---')) {
      note(where, `"${a.id}" IDENTITY.md still opens with YAML frontmatter`)
    }
    if (identity.length > IDENTITY_MAX_CHARS) {
      note(where, `"${a.id}" IDENTITY.md is ${identity.length} chars, over the prompt ceiling`)
    }
    if (new Set(a.tags).size !== a.tags.length) {
      note(where, `"${a.id}" repeats a tag`)
    }
  }

  for (const t of pack.teams) {
    // A "team" of one is a solo agent wearing a team's clothes; browse-by-agent
    // covers that case properly.
    if (t.members.length < 2) {
      note(where, `"${t.id}" has ${t.members.length} member(s); a team needs at least two`)
    }
    if (t.description.trim().length < 20) {
      note(where, `"${t.id}" description is too short to be useful`)
    }
    // Routing keyed by an id that is not on the roster silently never fires, and
    // a member with no routing deploys with no team instructions at all.
    const routing = loaded.teamBodies.get(t.id)?.routing ?? {}
    const members = new Set(t.members.map((m) => m.agentId))
    for (const key of Object.keys(routing)) {
      if (!members.has(key)) note(where, `"${t.id}" routes to "${key}", which is not a member`)
    }
    for (const member of members) {
      if (routing[member] === undefined) {
        note(where, `"${t.id}" has no routing for member "${member}"`)
      }
    }
  }

  // The denylist runs over EVERY string in the pack, listings and bodies alike.
  const values: [string, string][] = []
  stringFields(pack.agents, `${pack.id}.agents`, values)
  stringFields(pack.teams, `${pack.id}.teams`, values)
  stringFields([...loaded.agentBodies.values()], `${pack.id}.agentBodies`, values)
  stringFields([...loaded.teamBodies.values()], `${pack.id}.teamBodies`, values)
  for (const [at, text] of values) {
    const match = text.match(DENYLIST)
    if (match) note(where, `${at} names a competing registry or invite: "${match[0]}"`)
  }
}

// ─── Injection ───────────────────────────────────────────────────────────────

interface Hit {
  scope: string
  pattern: string
  line: number
  fingerprint: string
  excerpt: string
}

function scanInjection(chunks: Chunk[]): { block: Hit[]; review: Hit[] } {
  const block: Hit[] = []
  const review: Hit[] = []
  for (const c of chunks) {
    const evaluation = evaluateInjection(c.text, { surface: 'catalog', scope: c.scope })
    for (const f of evaluation.block) block.push({ scope: c.scope, ...f })
    for (const f of evaluation.review) review.push({ scope: c.scope, ...f })
  }
  return { block, review }
}

function describeHit(h: Hit): string {
  return `${h.scope}  [${h.pattern}] line ${h.line}\n      ${h.excerpt}\n      fingerprint ${h.fingerprint}`
}

/** Prettier's own quoting, so a regenerated allowlist passes `format:check`. */
function q(value: string): string {
  const singles = (value.match(/'/g) ?? []).length
  const doubles = (value.match(/"/g) ?? []).length
  const quote = singles > doubles ? '"' : "'"
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quote, 'g'), `\\${quote}`)
    .replace(/\n/g, '\\n')
  return `${quote}${escaped}${quote}`
}

function renderAllowlist(rows: CatalogInjectionAllowlistEntry[]): string {
  const body = rows
    .map(
      (r) =>
        `  {\n` +
        `    entry: ${q(r.entry)},\n` +
        `    rule: ${q(r.rule)},\n` +
        `    fingerprint: ${q(r.fingerprint)},\n` +
        `    why: ${q(r.why)},\n` +
        `    reviewedBy: ${q(r.reviewedBy)},\n` +
        `    reviewedAt: ${q(r.reviewedAt)},\n` +
        `  },\n`,
    )
    .join('')
  const literal = rows.length === 0 ? '[]' : `[\n${body}]`
  return `/**
 * Reviewed REVIEW-severity injection findings in the marketplace catalog.
 *
 * A \`review\` finding is machine-directed content (a SQL statement, a shell
 * command) on a prose surface. It does not block, because security-education
 * material legitimately quotes the payloads it teaches people to reject, but it
 * must not pass silently either, so \`scripts/catalog/validate.ts\` fails unless
 * every review finding is listed here with a human reason.
 *
 * The fingerprint is \`sha256(scope + rule label + the matched physical line)\`,
 * whitespace-collapsed and lowercased. The scope is \`<entry id>#<file>\`, so
 * renaming an entry or editing the payload line forces a fresh review instead of
 * silent inheritance.
 *
 * Regenerate with: \`tsx scripts/catalog/validate.ts --update-allowlist\`
 * (then replace \`pending-maintainer-signoff\` with a real reviewer and write a
 * real \`why\` for every new row).
 */

export interface CatalogInjectionAllowlistEntry {
  /** \`<catalog entry id>#<file>\`, the scope the fingerprint was computed over. */
  entry: string
  /** The rule label that fired, e.g. \`drop-table\`. */
  rule: string
  /** Full 64-hex sha256. */
  fingerprint: string
  /** Why this is content, not an attack. */
  why: string
  reviewedBy: string
  /** ISO date. */
  reviewedAt: string
}

export const CATALOG_INJECTION_ALLOWLIST: readonly CatalogInjectionAllowlistEntry[] = ${literal}
`
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const update = process.argv.includes('--update-allowlist')
  const config = loadConfig()
  const packs = loadAllPacks(config)

  const chunks: Chunk[] = []
  const seenIds = new Map<string, string>()
  const prefixes = new Map<string, string>()
  let agents = 0
  let teams = 0

  for (const loaded of packs) {
    const pack = checkPackStructure(loaded)
    if (!pack) continue
    checkContent(loaded, pack)
    chunks.push(...chunksOf(loaded, pack))
    agents += pack.agents.length
    teams += pack.teams.length

    // Ids are flat and global: they become filenames and URL segments, and the
    // app looks entries up across every pack at once.
    const prefix = pack.idPrefix ?? pack.id
    const owner = prefixes.get(prefix)
    if (owner !== undefined && owner !== pack.id) {
      note('catalog', `packs "${owner}" and "${pack.id}" both emit the "${prefix}-" id prefix`)
    }
    prefixes.set(prefix, pack.id)
    for (const entry of [...pack.agents, ...pack.teams]) {
      const previous = seenIds.get(entry.id)
      if (previous !== undefined) {
        note('catalog', `id "${entry.id}" is claimed by both "${previous}" and "${pack.id}"`)
      }
      seenIds.set(entry.id, pack.id)
    }
  }

  const { block, review } = scanInjection(chunks)

  if (update) {
    const rows = new Map<string, CatalogInjectionAllowlistEntry>()
    for (const h of review) {
      const prior = CATALOG_INJECTION_ALLOWLIST.find((e) => e.fingerprint === h.fingerprint)
      rows.set(
        h.fingerprint,
        prior ?? {
          entry: h.scope,
          rule: h.pattern,
          fingerprint: h.fingerprint,
          why: 'UNREVIEWED: describe why this content is not an attack.',
          reviewedBy: 'pending-maintainer-signoff',
          reviewedAt: new Date().toISOString().slice(0, 10),
        },
      )
    }
    const sorted = [...rows.values()].sort((a, b) => a.entry.localeCompare(b.entry))
    writeFileSync(ALLOWLIST_FILE, renderAllowlist(sorted), 'utf8')
    console.log(`catalog: wrote ${sorted.length} allowlist row(s) to ${ALLOWLIST_FILE}`)
    if (block.length === 0) return
  }

  const allowed = new Set(CATALOG_INJECTION_ALLOWLIST.map((e) => e.fingerprint))
  const unreviewed = review.filter((h) => !allowed.has(h.fingerprint))
  const stale = CATALOG_INJECTION_ALLOWLIST.filter(
    (e) => !review.some((h) => h.fingerprint === e.fingerprint),
  )

  console.log(
    `catalog: ${packs.length} pack(s), ${agents} agent(s), ${teams} team(s), ` +
      `${chunks.length} prose field(s) scanned`,
  )
  if (review.length - unreviewed.length > 0) {
    console.log(`catalog: ${review.length - unreviewed.length} review finding(s) allowlisted`)
  }

  // A row that matches nothing is a suppression for content that is gone. Left
  // in place it silently pre-approves whatever takes that fingerprint next.
  for (const e of stale) {
    note(
      'scripts/catalog/injection-allowlist.ts',
      `the row for "${e.entry}" matches no finding; delete it`,
    )
  }
  for (const h of block) note('injection', `BLOCKING ${describeHit(h)}`)
  for (const h of unreviewed) note('injection', `unreviewed REVIEW finding ${describeHit(h)}`)

  if (problems.length > 0) {
    console.error(`\ncatalog: ${problems.length} problem(s):\n`)
    for (const p of problems) console.error(`  ${p}`)
    console.error(
      '\nInjection findings need a row in scripts/catalog/injection-allowlist.ts ' +
        '(regenerate the skeleton with --update-allowlist, then write a real reason and reviewer).',
    )
    process.exit(1)
  }
  console.log('catalog: clean')
}

main()
