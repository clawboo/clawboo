/**
 * The variant registry: which runtime gets which Boo, and how to fetch one.
 *
 * This module is re-exported from the package root, so it MUST stay light. It may import types and
 * metadata only, never a variant module and never an SVG string. The four locked files are 188KB
 * raw and Hermes is 178KB of that, which is why every one of them sits behind a dynamic import.
 */
import { BOO_VARIANT_META } from './meta'
import type { BooSurface, BooVariantId, BooVariantMeta, BooVariantRenderer } from './types'

export const BOO_VARIANTS: Record<BooVariantId, BooVariantMeta> = BOO_VARIANT_META

/**
 * Runtime to variant. Only these three have brand artwork; every other runtime, and an agent whose
 * runtime is unknown or missing, keeps the generated mascot.
 */
const RUNTIME_VARIANTS: Record<string, BooVariantId> = {
  codex: 'codex',
  'claude-code': 'claude',
  hermes: 'hermes',
}

/** The variant an agent's runtime asks for, or `null` to keep the generated mascot. */
export function variantIdForRuntime(runtime?: string | null): BooVariantId | null {
  if (!runtime) return null
  return RUNTIME_VARIANTS[runtime.trim().toLowerCase()] ?? null
}

type VariantModule = { booVariant: BooVariantRenderer }

/*
 * One entry per chunk, not per variant: Hermes ships a light file and a dark file and they are the
 * heavy ones, so a light-theme viewer resolves `hermes:light` and never fetches the dark artwork.
 */
const LOADERS: Record<string, () => Promise<VariantModule>> = {
  codex: () => import('./codex'),
  claude: () => import('./claude'),
  'hermes:light': () => import('./hermes-light'),
  'hermes:dark': () => import('./hermes-dark'),
}

const chunkKey = (id: BooVariantId, surface: BooSurface): string =>
  id === 'hermes' ? `hermes:${surface}` : id

const cache = new Map<string, Promise<BooVariantRenderer>>()

/**
 * Load a variant's renderer, fetching its chunk once per surface and caching the result.
 *
 * `surface` picks the locked file; only Hermes ships a dark one, so the other variants ignore it. A
 * failed load is dropped from the cache so a later call can retry rather than replaying the error
 * for the rest of the session.
 */
export function loadBooVariant(
  id: BooVariantId,
  surface: BooSurface = 'light',
): Promise<BooVariantRenderer> {
  const key = chunkKey(id, surface)
  const load = LOADERS[key]
  if (!load) return Promise.reject(new Error(`unknown Boo variant "${id}"`))
  let pending = cache.get(key)
  if (!pending) {
    pending = load().then((m) => m.booVariant)
    cache.set(key, pending)
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key)
    })
  }
  return pending
}
