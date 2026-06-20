// Per-turn pricing for the native runtime's cost events. EXACT-match table for
// the models the harness pins; everything else is honestly `costUsd: null,
// estimated: true` (the Codex convention). Deliberately NOT reusing
// `../costUtils.calculateCostUsd`: its `default` fallback prices unknown models
// as Sonnet, which would report fabricated USD into the budget ledger. A
// trailing date suffix (`-YYYYMMDD`) is normalized before lookup — that is a
// deterministic alias, not fuzzy matching.

import type { Usage } from '@clawboo/executor'

interface ModelPrice {
  /** USD per million input tokens. */
  inPerM: number
  /** USD per million output tokens. */
  outPerM: number
}

const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5 },
  'claude-sonnet-4-6': { inPerM: 3, outPerM: 15 },
  'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6 },
  'gpt-4o': { inPerM: 2.5, outPerM: 10 },
  // OpenRouter ids for the same pinned models — list-price passthrough (the
  // common budget path: OpenRouter is the default fallback provider).
  'openai/gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6 },
  'anthropic/claude-haiku-4.5': { inPerM: 1, outPerM: 5 },
}

function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '')
}

export interface PricedTurn {
  costUsd: number | null
  estimated: boolean
}

export function priceTurn(model: string, usage: Usage): PricedTurn {
  const price = PRICES[normalizeModelId(model)]
  if (!price) return { costUsd: null, estimated: true }
  const usd =
    (usage.inputTokens / 1_000_000) * price.inPerM +
    (usage.outputTokens / 1_000_000) * price.outPerM
  return { costUsd: Math.round(usd * 1e6) / 1e6, estimated: false }
}
