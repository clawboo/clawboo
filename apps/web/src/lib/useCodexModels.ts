// The models the user's ChatGPT subscription can run, read live from their Codex
// CLI by the server (`/api/runtimes/codex/models`). There is no hardcoded
// fallback: the backend decides per account and it changes, so while the list is
// unknown the pickers offer only the plan default, which each CLI resolves itself.
//
// Backed by a module-level shared cache (the useOpenRouterModels pattern): every
// picker dedupes onto ONE fetch with no QueryClient dependency. The server caches
// for 10 minutes behind this; a mount refetches when our copy is stale.

import { useEffect, useState } from 'react'

import { fetchCodexModels, type CodexModels } from '@clawboo/control-client'

import {
  OPENAI_CODEX_GROUP_NAME,
  providerSlug,
  type ModelGroup,
  type ModelOption,
} from './modelCatalog'

const STALE_MS = 5 * 60 * 1000

let cache: CodexModels | null = null
let fetchedAt = 0
let inflight: Promise<void> | null = null
const subscribers = new Set<() => void>()

function loadCodexModels(): void {
  if ((cache && Date.now() - fetchedAt < STALE_MS) || inflight) return
  inflight = fetchCodexModels()
    .then((list) => {
      cache = list
      fetchedAt = Date.now()
      subscribers.forEach((cb) => cb())
    })
    .catch(() => {})
    .finally(() => {
      inflight = null
    })
}

/** Test seam: forget the shared copy so each test starts cold. */
export function resetCodexModelsCache(): void {
  cache = null
  fetchedAt = 0
  inflight = null
}

/** The plan's live models (bare backend ids, most capable first; empty while
 *  loading or unknown). `enabled: false` skips the fetch for a picker that will
 *  not show the subscription. */
export function useCodexModels(enabled = true): { models: ModelOption[]; isLoading: boolean } {
  const [, forceRender] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const cb = () => forceRender((n) => n + 1)
    subscribers.add(cb)
    loadCodexModels()
    return () => {
      subscribers.delete(cb)
    }
  }, [enabled])
  return { models: enabled ? (cache?.models ?? []) : [], isLoading: enabled && cache === null }
}

/** The plan's live models as ONE OpenClaw-format "OpenAI Codex" group
 *  (`openai-codex/<id>` routing ids). Pure. */
export function openClawCodexGroup(liveModels: ModelOption[]): ModelGroup {
  return {
    provider: OPENAI_CODEX_GROUP_NAME,
    models: liveModels.map((m) => ({ id: `openai-codex/${m.id}`, label: m.label })),
  }
}

/** `base` with its "OpenAI Codex" group filled from the live list: replaced (or
 *  appended) when the list is known; dropped while unknown, since that group has
 *  no models of its own and an empty provider column offers nothing. Pure. */
export function mergeCodexGroup(base: ModelGroup[], liveModels: ModelOption[]): ModelGroup[] {
  const isCodex = (g: ModelGroup) =>
    providerSlug(g.provider) === providerSlug(OPENAI_CODEX_GROUP_NAME)
  if (liveModels.length === 0) return base.filter((g) => !isCodex(g) || g.models.length > 0)
  const live = openClawCodexGroup(liveModels)
  if (!base.some(isCodex)) return [...base, live]
  return base.map((g) => (isCodex(g) ? live : g))
}
