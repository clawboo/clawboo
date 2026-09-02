// The one entry point every pack reader shares.
//
// SIX REJECT PATHS ARE WIRED, AND FOUR OF THEM ARE DEAD CODE AT v1. That is
// deliberate: their error text is written now, while there is time to write it
// well, instead of being invented the first time a user hits one.
//
// REJECT THE ENTRY, NEVER THE CATALOG. A caller that loads several packs must
// drop the pack that failed and keep the rest. `SelectTeamStep` renders with
// `allowStartFromScratch={false}`, so an empty catalog bricks first-run
// onboarding: one malformed third-party pack must not be able to do that.

import type { z } from 'zod'

import { SCHEMAS, STRICT_SCHEMAS, UPGRADES, type Upgrade } from './registry'
import type { AgentPack } from './types'
import { CURRENT_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION, SUPPORTED_RANGE } from './version'

export type PackRejectCode =
  | 'missing-schema-version'
  | 'schema-version-not-an-integer'
  | 'schema-version-too-new'
  | 'schema-version-too-old'
  | 'invalid-at-declared-version'
  | 'upgrade-produced-invalid-document'

/** One validation problem, flattened so a caller can print it without zod. */
export interface PackIssue {
  path: string
  message: string
}

export interface PackParseSuccess {
  ok: true
  pack: AgentPack
  /** The version the document declared, before any upgrade. */
  declaredVersion: number
  warnings: string[]
}

export interface PackParseFailure {
  ok: false
  code: PackRejectCode
  message: string
  /** `null` when the version could not be read at all. */
  declaredVersion: number | null
  issues: PackIssue[]
}

export type PackParseResult = PackParseSuccess | PackParseFailure

/**
 * What to do with a document that declares a SUPPORTED but older version.
 *
 * - `'allow'` — load it. Host runtime: a user's installed pack should not stop
 *   working because a newer format shipped.
 * - `'warn'` — load it and report. A future publish endpoint, so the author
 *   sees the nudge without being blocked.
 * - `'error'` — reject it. The in-repo gate: first-party content is re-emitted
 *   on every build, so a stale version in the tree is a build that did not run.
 */
export type StaleVersionPolicy = 'allow' | 'warn' | 'error'

/** The schemas and upgrades a parse runs against. Swapped by the repo gate and by tests. */
export interface Ladder {
  schemas: Readonly<Record<number, z.ZodTypeAny>>
  upgrades: Readonly<Record<number, Upgrade>>
  min: number
  current: number
}

/** Unknown keys are stripped. What a READER uses. */
export const DEFAULT_LADDER: Ladder = {
  schemas: SCHEMAS,
  upgrades: UPGRADES,
  min: MIN_SUPPORTED_SCHEMA_VERSION,
  current: CURRENT_SCHEMA_VERSION,
}

/** Unknown keys are an error. What the in-repo GATE uses. */
export const STRICT_LADDER: Ladder = {
  schemas: STRICT_SCHEMAS,
  upgrades: UPGRADES,
  min: MIN_SUPPORTED_SCHEMA_VERSION,
  current: CURRENT_SCHEMA_VERSION,
}

export interface ParseAgentPackOptions {
  /**
   * How to treat a supported-but-older schema version.
   *
   * DEFAULTS TO `'allow'`, which means a call site that forgets to pass this
   * silently permits stale content instead of failing loudly. That is the right
   * default for the host runtime, where refusing to load a user's installed pack
   * is worse than loading an old one, but it makes the omission invisible. Any
   * gate that means to enforce freshness has to say so.
   */
  staleVersionPolicy?: StaleVersionPolicy
  /** The schema/upgrade set to run against. Defaults to `DEFAULT_LADDER`. */
  ladder?: Ladder
}

function issuesOf(error: z.ZodError): PackIssue[] {
  return error.issues.map((i) => ({
    path: i.path.length > 0 ? i.path.join('.') : '(root)',
    message: i.message,
  }))
}

function fail(
  code: PackRejectCode,
  message: string,
  declaredVersion: number | null,
  issues: PackIssue[] = [],
): PackParseFailure {
  return { ok: false, code, message, declaredVersion, issues }
}

/**
 * Walk `doc` from `from` up to `to` through the upgrade chain.
 *
 * Exported so the self-check that follows it can be tested against a chain that
 * really does produce a broken document. With `UPGRADES` empty this is a no-op
 * at v1, and a test that could only exercise the no-op would prove nothing.
 */
export function runUpgrades(
  doc: Record<string, unknown>,
  from: number,
  to: number,
  upgrades: Readonly<Record<number, Upgrade>>,
): { doc: Record<string, unknown>; applied: number[] } {
  let current = doc
  const applied: number[] = []
  for (let v = from; v < to; v++) {
    const step = upgrades[v]
    if (!step) break
    current = step(current)
    applied.push(v)
  }
  return { doc: current, applied }
}

/**
 * Validate one pack document and return it at `CURRENT_SCHEMA_VERSION`.
 *
 * Never throws on bad input: a malformed pack is a result, not an exception, so
 * the caller can drop one entry and keep the catalog.
 */
export function parseAgentPack(raw: unknown, options: ParseAgentPackOptions = {}): PackParseResult {
  const { staleVersionPolicy = 'allow', ladder = DEFAULT_LADDER } = options
  const warnings: string[] = []

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail(
      'missing-schema-version',
      'A pack must be a JSON object whose first key is an integer "schemaVersion".',
      null,
    )
  }

  const doc = raw as Record<string, unknown>
  const declared = doc.schemaVersion

  // 1. Missing. NEVER default to 1: a document with no version is a document of
  //    unknown shape, and guessing turns one bad file into a permanent dual-read
  //    in every reader that follows.
  if (declared === undefined || declared === null) {
    return fail(
      'missing-schema-version',
      'This pack has no "schemaVersion". Every pack must declare one as its first key ' +
        `(this build reads ${SUPPORTED_RANGE}). It is not assumed, because a pack of ` +
        'unknown shape cannot be read safely.',
      null,
    )
  }

  // 2. Not an integer. `"1"` and `1.0.0` are the two spellings people reach for.
  if (typeof declared !== 'number' || !Number.isInteger(declared)) {
    return fail(
      'schema-version-not-an-integer',
      `This pack declares schemaVersion ${JSON.stringify(declared)}. It must be an ` +
        'INTEGER, not a string and not a semver: the schema version selects a reader, ' +
        'while the pack\'s own "version" field names the content build.',
      null,
    )
  }

  // 3. Too new. The reader is the thing that is out of date here, so the message
  //    points at the upgrade rather than at the pack.
  if (declared > ladder.current) {
    return fail(
      'schema-version-too-new',
      `This pack is schema ${declared}; this build reads ${SUPPORTED_RANGE}. ` +
        'Upgrade Clawboo to install this pack.',
      declared,
    )
  }

  // 4. Too old to read at all.
  if (declared < ladder.min) {
    return fail(
      'schema-version-too-old',
      `This pack is schema ${declared}, below the oldest version this build reads ` +
        `(${SUPPORTED_RANGE}). Re-publish the pack at schemaVersion ${ladder.current}.`,
      declared,
    )
  }

  // 4b. Old but readable. The POLICY decides, and the default lets it through.
  if (declared < ladder.current) {
    const note =
      `This pack is schema ${declared}; the current version is ${ladder.current}.` +
      ` Re-publish the pack at schemaVersion ${ladder.current}.`
    if (staleVersionPolicy === 'error') {
      return fail('schema-version-too-old', note, declared)
    }
    if (staleVersionPolicy === 'warn') warnings.push(note)
  }

  // 5. Validate AT THE DECLARED VERSION first, so the issues point at the shape
  //    the author actually wrote rather than at the upgraded document they have
  //    never seen.
  const declaredSchema = ladder.schemas[declared]
  if (!declaredSchema) {
    return fail(
      'schema-version-too-old',
      `This build has no validator for schema ${declared}, although ${SUPPORTED_RANGE} ` +
        'is advertised as supported. The version ladder is incomplete.',
      declared,
    )
  }
  const atDeclared = declaredSchema.safeParse(doc)
  if (!atDeclared.success) {
    return fail(
      'invalid-at-declared-version',
      `This pack does not match schema ${declared}.`,
      declared,
      issuesOf(atDeclared.error),
    )
  }

  // 6. Upgrade, then CHECK THE RESULT. Four lines that turn "a corrupt pack was
  //    silently installed" into a caught error.
  const { doc: upgraded } = runUpgrades(
    atDeclared.data as Record<string, unknown>,
    declared,
    ladder.current,
    ladder.upgrades,
  )
  const currentSchema = ladder.schemas[ladder.current]
  if (!currentSchema) {
    return fail(
      'upgrade-produced-invalid-document',
      `This build has no validator for its own current schema ${ladder.current}.`,
      declared,
    )
  }
  const atCurrent = currentSchema.safeParse(upgraded)
  if (!atCurrent.success) {
    return fail(
      'upgrade-produced-invalid-document',
      `Upgrading this pack from schema ${declared} to ${ladder.current} produced a ` +
        'document that does not match schema ' +
        `${ladder.current}. The upgrade chain is wrong, not the pack.`,
      declared,
      issuesOf(atCurrent.error),
    )
  }

  return { ok: true, pack: atCurrent.data as AgentPack, declaredVersion: declared, warnings }
}
