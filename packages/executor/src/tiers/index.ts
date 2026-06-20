// KV-/prompt-cache discipline primitives. The rules every shipping harness
// converged on: stable → context → volatile tiers; deterministically-sorted
// tool definitions; date-only timestamps (never minute/second precision);
// append-don't-mutate the cached prefix. Pure + browser-safe (no node:*).

import type { AssembledPrompt, PromptTiers, ToolDef } from './types'

export type { AssembledPrompt, CacheBreakpoint, PromptTiers, ToolDef } from './types'

const SEP = '\n\n'

/** UTF-8 byte length — the unit providers cache on. `TextEncoder` is global in
 *  Node 22+ and every browser, so this stays browser-safe (no `Buffer`). */
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * Date-only stamp (`YYYY-MM-DD`, UTC). NEVER minute/second precision — a
 * fine-grained timestamp in the prompt busts the KV prefix cache on every
 * rebuild (the Hermes footgun). If a runtime needs wall-clock time, expose it
 * as a tool; never bake it into the cacheable prefix.
 */
export function dateStamp(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Deterministically sort tool definitions by name. Tool-array order is a
 * load-bearing cache key: an unsorted (or hash-map-ordered) list re-orders
 * turn-to-turn and busts the cached tool-definitions prefix. Non-mutating.
 */
export function sortToolDefs<T extends ToolDef>(defs: readonly T[]): T[] {
  return [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Assemble the three tiers into one prompt and report the cacheable prefix +
 * suggested cache breakpoints. Order is stable → context → volatile so the
 * frozen content forms the cacheable head and only the volatile tail changes
 * per turn (append-don't-mutate). Empty tiers are skipped (no stray separators).
 */
export function assembleTiers(tiers: PromptTiers): AssembledPrompt {
  const { stable, context, volatile } = tiers
  const stablePrefix = context ? `${stable}${SEP}${context}` : stable
  const prompt = volatile ? `${stablePrefix}${SEP}${volatile}` : stablePrefix

  const cacheBreakpoints: AssembledPrompt['cacheBreakpoints'] = [
    { offset: byteLen(stable), label: 'stable' },
  ]
  if (context) cacheBreakpoints.push({ offset: byteLen(stablePrefix), label: 'context' })

  return {
    prompt,
    stablePrefix,
    stablePrefixBytes: byteLen(stablePrefix),
    cacheBreakpoints,
  }
}
