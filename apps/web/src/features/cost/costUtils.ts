// ─── Model pricing per million tokens (USD) ───────────────────────────────────

const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-opus-4-6': { inputPerM: 15, outputPerM: 75 },
  'claude-opus-4': { inputPerM: 15, outputPerM: 75 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'claude-sonnet-4': { inputPerM: 3, outputPerM: 15 },
  'claude-sonnet-3-7': { inputPerM: 3, outputPerM: 15 },
  'claude-haiku-4-5': { inputPerM: 0.25, outputPerM: 1.25 },
  'claude-haiku-3-5': { inputPerM: 0.25, outputPerM: 1.25 },
  default: { inputPerM: 3, outputPerM: 15 },
}

function getPricing(model: string): { inputPerM: number; outputPerM: number } {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]!
  const lower = model.toLowerCase()
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== 'default' && lower.includes(key.toLowerCase())) return pricing
  }
  return MODEL_PRICING['default']!
}

export function calculateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = getPricing(model)
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerM
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerM
  return inputCost + outputCost
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.001) return `$${usd.toFixed(6)}`
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(4)}`
  if (usd < 10) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}
