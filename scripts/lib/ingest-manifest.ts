/**
 * The marketplace catalog integrity manifest — `scripts/ingest-manifest.json`.
 *
 * Written by `pnpm ingest:marketplace` (and re-blessed by `pnpm ingest:manifest`),
 * asserted OFFLINE by `pnpm verify:catalog`. It records the two pinned upstream
 * commits plus a checksum for every generated catalog file, so the publish job can
 * prove the committed catalog is intact without reaching out to GitHub — an upstream
 * rename or force-push can no longer hold up a release.
 *
 * It is a DRIFT DETECTOR, not an anti-tamper control: anyone who can commit can
 * regenerate it. `pnpm verify:ingest` (live, re-derives from upstream) remains the
 * semantic authority; see docs/internals/codegen-and-ingestion.md.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import prettier from 'prettier'

import {
  AGENCY_AGENTS_REPO,
  AGENCY_AGENTS_SHA,
  AWESOME_OPENCLAW_REPO,
  AWESOME_OPENCLAW_SHA,
  CATALOG_FILE_COUNT,
  REPO_ROOT,
  catalogFilePaths,
} from './ingest-helpers.js'

export const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts/ingest-manifest.json')
export const MANIFEST_VERSION = 1

const MANIFEST_COMMENT =
  'AUTO-GENERATED — do not edit manually. Regenerate: pnpm ingest:marketplace. ' +
  'Asserted offline by: pnpm verify:catalog. Hashes are sha256 of each file’s Prettier-canonical form.'

export interface ManifestSource {
  repo: string
  sha: string
}

export interface CatalogManifest {
  $comment: string
  version: number
  /** The pinned upstream commits the catalog was generated from. */
  sources: Record<string, ManifestSource>
  /** Repo-relative POSIX path → sha256 of the file's canonical form. */
  files: Record<string, string>
}

/**
 * Manifest keys are repo-relative and slash-separated. `path.join` yields
 * backslashes on Windows, so a regen there would otherwise rewrite all 20 keys.
 */
export function repoRelativePosix(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/')
}

/**
 * The form a catalog file is hashed in.
 *
 * NOT the file's raw bytes, deliberately. `prettier.format({ parser, filepath })`
 * does NOT resolve `.prettierrc` — so the generator's `writeFormatted()` emits
 * DEFAULT-styled output (double quotes, semicolons, printWidth 80) which the
 * pre-commit `prettier --write` hook then restyles to repo style. Raw-byte hashes
 * would go stale before the first commit landed.
 *
 * Running both sides through this one call — the same normalization
 * `verify-ingest.ts` already does before diffing — makes the hash invariant to
 * code style, to `.prettierrc` changes, and to CRLF (Prettier re-emits LF, and
 * there is no `.gitattributes`, so a Windows checkout may hold CRLF). It is also
 * idempotent, so writer and verifier agree regardless of which form is on disk.
 *
 * The one thing it IS sensitive to is a Prettier major bump changing the canonical
 * form — that is what `pnpm ingest:manifest` exists to re-bless.
 */
export async function canonicalize(text: string, filePath: string): Promise<string> {
  return prettier.format(text, { parser: 'typescript', filepath: filePath })
}

/** sha256 (hex) of a catalog file's canonical form. */
export async function hashCatalogFile(absPath: string): Promise<string> {
  const raw = await fs.readFile(absPath, 'utf8')
  const canonical = await canonicalize(raw, absPath)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** Stable one-line rendering of a `sources` map, for comparison and for messages. */
export function describeSources(sources: Record<string, ManifestSource>): string {
  return Object.entries(sources)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, { repo, sha }]) => `${key}=${repo}@${sha}`)
    .join(', ')
}

/** The two pinned upstream commits, as the manifest records them. */
export function expectedSources(): Record<string, ManifestSource> {
  return {
    'agency-agents': { repo: AGENCY_AGENTS_REPO, sha: AGENCY_AGENTS_SHA },
    'awesome-openclaw': { repo: AWESOME_OPENCLAW_REPO, sha: AWESOME_OPENCLAW_SHA },
  }
}

/** Hash every generated file on disk and assemble the manifest. */
export async function buildManifest(): Promise<CatalogManifest> {
  const entries = await Promise.all(
    catalogFilePaths().map(async (absPath): Promise<[string, string]> => [
      repoRelativePosix(absPath),
      await hashCatalogFile(absPath),
    ]),
  )

  // Sorted keys, so the JSON diff stays readable and reordering the enumeration
  // in `catalogFilePaths()` doesn't churn the file.
  const files: Record<string, string> = {}
  for (const [key, hash] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    files[key] = hash
  }

  return {
    $comment: MANIFEST_COMMENT,
    version: MANIFEST_VERSION,
    sources: expectedSources(),
    files,
  }
}

/** Stable on-disk form. Listed in `.prettierignore` so `pnpm format` leaves it alone. */
export function serializeManifest(manifest: CatalogManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Build the manifest from disk and write it. Returns the file count for logging. */
export async function writeManifest(): Promise<number> {
  const manifest = await buildManifest()
  await fs.writeFile(MANIFEST_PATH, serializeManifest(manifest), 'utf8')
  return Object.keys(manifest.files).length
}

/**
 * Read + validate the committed manifest. Throws a remediation-shaped error when
 * it is missing or malformed — `verify-catalog.ts` surfaces the message verbatim.
 */
export async function readManifest(): Promise<CatalogManifest> {
  const rel = repoRelativePosix(MANIFEST_PATH)
  let raw: string
  try {
    raw = await fs.readFile(MANIFEST_PATH, 'utf8')
  } catch {
    throw new Error(`${rel} is missing — run \`pnpm ingest:marketplace\` to generate it.`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${rel} is not valid JSON (${(err as Error).message}).`)
  }

  const m = parsed as Partial<CatalogManifest>
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    throw new Error(`${rel} must be a JSON object.`)
  }
  if (m.version !== MANIFEST_VERSION) {
    throw new Error(
      `${rel} has version ${String(m.version)}, expected ${MANIFEST_VERSION} — ` +
        'run `pnpm ingest:manifest` to rewrite it in the current format.',
    )
  }
  if (typeof m.sources !== 'object' || m.sources === null) {
    throw new Error(`${rel} is missing its \`sources\` object.`)
  }
  if (typeof m.files !== 'object' || m.files === null) {
    throw new Error(`${rel} is missing its \`files\` object.`)
  }

  return m as CatalogManifest
}

export { CATALOG_FILE_COUNT, catalogFilePaths }
