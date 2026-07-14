// Live OpenRouter model list, kept fresh from OpenRouter's public catalog (via the
// server's cached /api/runtimes/openrouter/models). Falls back to the small
// hardcoded set (nativeModelCatalog) while loading or if OpenRouter is unreachable,
// so a picker is never empty.
//
// Backed by a module-level shared cache (NOT React Query): every picker across the
// app dedupes onto ONE fetch, with no dependency on a QueryClient context — so the
// isolated component tests that render a picker on its own need no provider. The
// server caches for 30 min behind this; a mount refetches when our copy is stale.

import { useEffect, useMemo, useState } from 'react'

import { fetchOpenRouterModels } from '@clawboo/control-client'

import type { ModelGroup, ModelOption } from './modelCatalog'
import {
  ANTHROPIC_GROUP_NAME,
  NATIVE_MODEL_GROUPS,
  OPENAI_GROUP_NAME,
  OPENROUTER_GROUP_NAME,
} from './nativeModelCatalog'
import { HERMES_MODEL_GROUPS, HERMES_OPENROUTER_GROUP_NAME } from './hermesModelCatalog'
import { useProviderModels } from './useProviderModels'

const FALLBACK_OPENROUTER_MODELS: ModelOption[] =
  NATIVE_MODEL_GROUPS.find((g) => g.provider === OPENROUTER_GROUP_NAME)?.models ?? []

const STALE_MS = 15 * 60 * 1000 // refetch when our copy is older than this

let cache: ModelOption[] | null = null
let fetchedAt = 0
let inflight: Promise<void> | null = null
const subscribers = new Set<() => void>()

/** Fetch the live list once (deduped) if we have none or ours is stale; notify
 *  every mounted picker on success. Failures are swallowed (callers use the
 *  fallback), so this never throws. */
function loadOpenRouterModels(): void {
  const now = Date.now()
  if ((cache && now - fetchedAt < STALE_MS) || inflight) return
  inflight = fetchOpenRouterModels()
    .then((models) => {
      if (models.length > 0) {
        cache = models
        fetchedAt = Date.now()
        subscribers.forEach((cb) => cb())
      }
    })
    .catch(() => {})
    .finally(() => {
      inflight = null
    })
}

export interface OpenRouterModels {
  /** Flat list (for the single-provider `Select` pickers). Falls back to the small
   *  hardcoded set while loading / on error, so a picker is never empty. */
  models: ModelOption[]
  /** The live list ONLY — empty until the fetch has succeeded (no hardcoded
   *  fallback). The OpenClaw merge uses this so it keeps its own base list until
   *  real data arrives rather than swapping in native fallbacks. */
  liveModels: ModelOption[]
  /** The one "OpenRouter" group (for the grouped native selectors). */
  group: ModelGroup
  isLoading: boolean
}

/** The live OpenRouter model list + its single "OpenRouter" group. Falls back to
 *  the hardcoded set while loading / on error, so the caller always has models. */
export function useOpenRouterModels(): OpenRouterModels {
  const [, forceRender] = useState(0)
  useEffect(() => {
    const cb = () => forceRender((n) => n + 1)
    subscribers.add(cb)
    loadOpenRouterModels()
    return () => {
      subscribers.delete(cb)
    }
  }, [])
  const liveModels = cache && cache.length > 0 ? cache : []
  const models = liveModels.length > 0 ? liveModels : FALLBACK_OPENROUTER_MODELS
  const group = useMemo<ModelGroup>(() => ({ provider: OPENROUTER_GROUP_NAME, models }), [models])
  return { models, liveModels, group, isLoading: cache === null }
}

/** NATIVE_MODEL_GROUPS with each provider group's models swapped for its LIVE list:
 *  OpenRouter (public catalog) + Anthropic / OpenAI (enumerated with the stored
 *  key, empty until loaded → static fallback stays). Used by the grouped native
 *  pickers (create-team + agent detail), which key their per-provider greying on
 *  the group name, so each provider stays ONE group here. */
export function useNativeModelGroups(): ModelGroup[] {
  const { models: openrouter } = useOpenRouterModels()
  const anthropic = useProviderModels('anthropic')
  const openai = useProviderModels('openai')
  return useMemo(
    () =>
      NATIVE_MODEL_GROUPS.map((g) => {
        if (g.provider === OPENROUTER_GROUP_NAME) return { ...g, models: openrouter }
        if (g.provider === ANTHROPIC_GROUP_NAME && anthropic.length > 0) return { ...g, models: anthropic }
        if (g.provider === OPENAI_GROUP_NAME && openai.length > 0) return { ...g, models: openai }
        return g
      }),
    [openrouter, anthropic, openai],
  )
}

/** The Hermes model groups: a SINGLE "OpenRouter" group with the LIVE OpenRouter
 *  catalog (Hermes reaches every model through OpenRouter with one key), falling back
 *  to the small curated set while loading / on error. Every pick therefore pins
 *  `--provider openrouter`, so it always works with the connected OpenRouter key. */
export function useHermesModelGroups(): ModelGroup[] {
  const { liveModels } = useOpenRouterModels()
  return useMemo(
    () => [
      {
        provider: HERMES_OPENROUTER_GROUP_NAME,
        models: liveModels.length > 0 ? liveModels : HERMES_MODEL_GROUPS[0]!.models,
      },
    ],
    [liveModels],
  )
}

// ─── OpenClaw path ───────────────────────────────────────────────────────────
// The OpenClaw runtime addresses OpenRouter models by a ROUTING id — `openrouter/`
// + the raw OpenRouter `vendor/model` id (e.g. `openrouter/anthropic/claude-sonnet-4.5`),
// distinct from the native path's bare `vendor/model`. These map the SAME live list
// into that format so the OpenClaw model pickers reflect the live catalog too.

/** The live OpenRouter models as ONE OpenClaw-format "OpenRouter" group, or null
 *  when the live list hasn't loaded (caller then keeps its own base list). Pure. */
export function openClawOpenRouterGroup(liveModels: ModelOption[]): ModelGroup | null {
  if (liveModels.length === 0) return null
  return {
    provider: OPENROUTER_GROUP_NAME,
    models: liveModels.map((m) => ({ id: `openrouter/${m.id}`, label: m.label })),
  }
}

/** Replace the base groups' OpenRouter group (case-insensitive) with `orGroup`, or
 *  append it if absent. Returns `base` unchanged when `orGroup` is null. Pure. */
export function mergeOpenRouterGroup(base: ModelGroup[], orGroup: ModelGroup | null): ModelGroup[] {
  if (!orGroup) return base
  if (!base.some((g) => g.provider.toLowerCase() === 'openrouter')) return [...base, orGroup]
  return base.map((g) => (g.provider.toLowerCase() === 'openrouter' ? orGroup : g))
}

/** `base` groups with the OpenRouter group swapped for the live list in OpenClaw
 *  routing-id format. Keeps `base` untouched until the live list loads. */
export function useOpenClawModelGroups(base: ModelGroup[]): ModelGroup[] {
  const { liveModels } = useOpenRouterModels()
  return useMemo(() => mergeOpenRouterGroup(base, openClawOpenRouterGroup(liveModels)), [base, liveModels])
}
