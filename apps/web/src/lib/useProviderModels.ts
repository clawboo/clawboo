// Live model lists for the key-authenticated native providers (Anthropic, OpenAI),
// via the server's cached GET /api/providers/:id/models (which enumerates the
// provider's models using the stored vault/.env key). Same module-cache-per-
// provider pattern as useOpenRouterModels: every picker dedupes onto ONE fetch per
// provider with no QueryClient dependency. Returns [] until a live list loads (or
// if no key is stored — the keyless case), so callers keep their static fallback.

import { useEffect, useState } from 'react'

import { fetchProviderModels } from '@clawboo/control-client'

import type { ModelOption } from './modelCatalog'

const STALE_MS = 15 * 60 * 1000

interface Entry {
  cache: ModelOption[] | null
  fetchedAt: number
  inflight: Promise<void> | null
}
const entries = new Map<string, Entry>()
const subscribers = new Map<string, Set<() => void>>()

function entryFor(id: string): Entry {
  let e = entries.get(id)
  if (!e) {
    e = { cache: null, fetchedAt: 0, inflight: null }
    entries.set(id, e)
  }
  return e
}
function subsFor(id: string): Set<() => void> {
  let s = subscribers.get(id)
  if (!s) {
    s = new Set()
    subscribers.set(id, s)
  }
  return s
}

function load(id: string): void {
  const e = entryFor(id)
  const now = Date.now()
  if ((e.cache && now - e.fetchedAt < STALE_MS) || e.inflight) return
  e.inflight = fetchProviderModels(id)
    .then((models) => {
      if (models.length > 0) {
        e.cache = models
        e.fetchedAt = Date.now()
        subsFor(id).forEach((cb) => cb())
      }
    })
    .catch(() => {})
    .finally(() => {
      e.inflight = null
    })
}

/** The live model list for a key-authenticated provider ('anthropic' / 'openai').
 *  Empty until it loads, or if no key is stored for that provider. */
export function useProviderModels(id: string): ModelOption[] {
  const [, forceRender] = useState(0)
  useEffect(() => {
    const cb = () => forceRender((n) => n + 1)
    const subs = subsFor(id)
    subs.add(cb)
    load(id)
    return () => {
      subs.delete(cb)
    }
  }, [id])
  const e = entries.get(id)
  return e?.cache && e.cache.length > 0 ? e.cache : []
}
