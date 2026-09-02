// The on-disk shape of `catalog/`, and the loader every catalog script shares.
//
// `catalog/` is a plain content folder, NOT a pnpm workspace member and not part
// of any turbo task. That is the whole point of the split: adding a pack must
// not put a content PR through `turbo lint/typecheck/test`. The scripts here are
// the only code that reads it, and they run from the repo root under tsx.
//
// Layout:
//   catalog/catalog.config.json          which packs exist, and where the index lives
//   catalog/schema/{pack,index}.schema.json   the PUBLIC specification
//   catalog/packs/<publisher>/<slug>/pack.json    manifest + listings (body = a path)
//   catalog/packs/<publisher>/<slug>/agents/<slug>.json   one AgentBody each
//   catalog/packs/<publisher>/<slug>/teams/<slug>.json    one TeamBody each
//   catalog/packs/<publisher>/<slug>/NOTICE.md   required when provenance.repo is set
//   catalog/dist/v1/index.json                   COMMITTED, generated
//   catalog/dist/v1/packs/<publisher>/<slug>/<version>.json   COMMITTED, generated
//
// The relative import into `packages/pack-format/src` is deliberate. The repo
// root has no `workspace:*` devDependencies (there is no in-repo precedent that
// pnpm resolves one from the root), and pack-format's own `zod` dependency
// resolves from the importing FILE's directory, so a relative import works while
// a bare `@clawboo/pack-format` from the root would not. The retired
// `scripts/lib/ingest-helpers.ts` reached into the tree the same way.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentBody, AgentPack, TeamBody } from '../../../packages/pack-format/src/index.ts'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const CATALOG_DIR = path.join(REPO_ROOT, 'catalog')
export const PACKS_DIR = path.join(CATALOG_DIR, 'packs')
export const DIST_DIR = path.join(CATALOG_DIR, 'dist')
export const CONFIG_FILE = path.join(CATALOG_DIR, 'catalog.config.json')

export interface PackRef {
  publisher: string
  slug: string
}

export interface CatalogConfig {
  schemaVersion: number
  /** The dist channel directory, e.g. `v1`. */
  dist: string
  /** The pack whose content is compiled into the app as the offline seed. */
  seed: PackRef
  packs: PackRef[]
  index: { url: string; fallbackUrl: string }
}

/**
 * A pack as it sits in `catalog/packs/**`: the manifest with its listings, plus
 * the body documents each listing points at.
 */
export interface LoadedPack {
  ref: PackRef
  dir: string
  pack: AgentPack
  agentBodies: Map<string, AgentBody>
  teamBodies: Map<string, TeamBody>
  /** Present when the pack ships one. Required by `validate.ts` when provenance.repo is set. */
  notice: string | null
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

export function loadConfig(): CatalogConfig {
  return readJson<CatalogConfig>(CONFIG_FILE)
}

export function packDir(ref: PackRef): string {
  return path.join(PACKS_DIR, ref.publisher, ref.slug)
}

export function distDir(config: CatalogConfig): string {
  return path.join(DIST_DIR, config.dist)
}

/** `catalog/dist/<channel>/packs/<publisher>/<slug>/<version>.json`. */
export function bundlePath(config: CatalogConfig, ref: PackRef, version: string): string {
  return path.join(distDir(config), 'packs', ref.publisher, ref.slug, `${version}.json`)
}

/** The same path as a POSIX URL suffix, for the index rows. */
export function bundleUrlPath(config: CatalogConfig, ref: PackRef, version: string): string {
  return `${config.dist}/packs/${ref.publisher}/${ref.slug}/${version}.json`
}

function loadBodies<T extends { id: string }>(dir: string): Map<string, T> {
  const out = new Map<string, T>()
  if (!existsSync(dir)) return out
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue
    const body = readJson<T>(path.join(dir, file))
    out.set(body.id, body)
  }
  return out
}

export function loadPack(ref: PackRef): LoadedPack {
  const dir = packDir(ref)
  const noticeFile = path.join(dir, 'NOTICE.md')
  return {
    ref,
    dir,
    pack: readJson<AgentPack>(path.join(dir, 'pack.json')),
    agentBodies: loadBodies<AgentBody>(path.join(dir, 'agents')),
    teamBodies: loadBodies<TeamBody>(path.join(dir, 'teams')),
    notice: existsSync(noticeFile) ? readFileSync(noticeFile, 'utf8') : null,
  }
}

export function loadAllPacks(config: CatalogConfig = loadConfig()): LoadedPack[] {
  return config.packs.map(loadPack)
}

export function refEquals(a: PackRef, b: PackRef): boolean {
  return a.publisher === b.publisher && a.slug === b.slug
}
