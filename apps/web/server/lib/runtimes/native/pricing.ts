// Per-turn pricing for the native runtime's cost events. EXACT-match table for
// the models the harness pins; everything else is honestly `costUsd: null,
// estimated: true` (the Codex convention). Deliberately NOT reusing
// `../costUtils.calculateCostUsd`: its `default` fallback prices unknown models
// as Sonnet, which would report fabricated USD into the budget ledger. A
// trailing date suffix (`-YYYYMMDD`) is normalized before lookup — that is a
// deterministic alias, not fuzzy matching. A turn a local Ollama served costs
// nothing, so it is priced at an exact $0 and flagged `local`.

import type { Usage } from '@clawboo/executor'

import { isLocalModel } from '../../costUtils'

interface ModelPrice {
  /** USD per million uncached input tokens. */
  inPerM: number
  /** USD per million output tokens. */
  outPerM: number
  /** USD per million input tokens read from the prompt cache (else `inPerM`). */
  cachedInPerM?: number
  /** USD per million input tokens written to the prompt cache (else `inPerM`). */
  cacheWriteInPerM?: number
}

const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5, cachedInPerM: 0.1, cacheWriteInPerM: 1.25 },
  'claude-sonnet-4-6': { inPerM: 3, outPerM: 15, cachedInPerM: 0.3, cacheWriteInPerM: 3.75 },
  'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6, cachedInPerM: 0.075 },
  'gpt-4o': { inPerM: 2.5, outPerM: 10, cachedInPerM: 1.25 },
  // OpenRouter ids for the same pinned models — list-price passthrough (the
  // common budget path: OpenRouter is the default fallback provider).
  'openai/gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6, cachedInPerM: 0.075 },
  'anthropic/claude-haiku-4.5': {
    inPerM: 1,
    outPerM: 5,
    cachedInPerM: 0.1,
    cacheWriteInPerM: 1.25,
  },
}

/** Every model id this table prices, so a test can hold costUtils to the same rates. */
export const NATIVE_PRICED_MODELS: readonly string[] = Object.keys(PRICES)

function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '')
}

export interface PricedTurn {
  costUsd: number | null
  estimated: boolean
  /** The turn ran on a local Ollama, so its $0 is exact rather than unknown. */
  local?: boolean
}

/** `usage.inputTokens` is the whole prompt; `usage.cachedInputTokens` and
 *  `cacheWriteTokens` are the shares of it read from and written to the cache. */
export function priceTurn(
  model: string,
  usage: Usage,
  provider?: string | null,
  cacheWriteTokens = 0,
): PricedTurn {
  if (isLocalModel(model, provider)) return { costUsd: 0, estimated: false, local: true }
  const price = PRICES[normalizeModelId(model)]
  if (!price) return { costUsd: null, estimated: true }
  const cached = usage.cachedInputTokens ?? 0
  const fresh = Math.max(0, usage.inputTokens - cached - cacheWriteTokens)
  const usd =
    (fresh / 1_000_000) * price.inPerM +
    (cached / 1_000_000) * (price.cachedInPerM ?? price.inPerM) +
    (cacheWriteTokens / 1_000_000) * (price.cacheWriteInPerM ?? price.inPerM) +
    (usage.outputTokens / 1_000_000) * price.outPerM
  return { costUsd: Math.round(usd * 1e6) / 1e6, estimated: false }
}
