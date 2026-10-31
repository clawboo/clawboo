// ─── Model pricing per million tokens (USD) ───────────────────────────────────

// Anthropic list prices, verified on 2026-09-28 against
// https://platform.claude.com/docs/en/about-claude/pricing. The substring pass in
// getPricing walks these keys in order, so a more specific id sits before any key
// it contains (claude-opus-4-5 before claude-opus-4, claude-opus-5-5 before
// claude-opus-5). Sonnet 3.7 and Haiku 3.5 shipped as claude-3-7-sonnet and
// claude-3-5-haiku, so both spellings are keyed.
const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-fable-5-1': { inputPerM: 10, outputPerM: 50 },
  'claude-fable-5': { inputPerM: 10, outputPerM: 50 },
  'claude-opus-5-5': { inputPerM: 4, outputPerM: 20 },
  'claude-opus-5': { inputPerM: 5, outputPerM: 25 },
  'claude-opus-4-8': { inputPerM: 5, outputPerM: 25 },
  'claude-opus-4-7': { inputPerM: 5, outputPerM: 25 },
  'claude-opus-4-6': { inputPerM: 5, outputPerM: 25 },
  'claude-opus-4-5': { inputPerM: 5, outputPerM: 25 },
  'claude-opus-4-1': { inputPerM: 15, outputPerM: 75 },
  'claude-opus-4': { inputPerM: 15, outputPerM: 75 },
  'claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10 },
  'claude-sonnet-5': { inputPerM: 2, outputPerM: 10 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'claude-sonnet-4-5': { inputPerM: 3, outputPerM: 15 },
  'claude-sonnet-4': { inputPerM: 3, outputPerM: 15 },
  'claude-sonnet-3-7': { inputPerM: 3, outputPerM: 15 },
  'claude-3-7-sonnet': { inputPerM: 3, outputPerM: 15 },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
  'claude-haiku-3-5': { inputPerM: 0.8, outputPerM: 4 },
  'claude-3-5-haiku': { inputPerM: 0.8, outputPerM: 4 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  default: { inputPerM: 3, outputPerM: 15 },
}

// A model Ollama serves runs on hardware the user owns, so its tokens cost
// nothing. It is named two ways: an OpenClaw ref (`ollama/llama3.2`), or a bare
// id with the provider beside it (a native agent, an OpenClaw session snapshot).
// Ollama's cloud models (a `-cloud` or `:cloud` tag) run on ollama.com, so they
// are not free and keep the default rate.
const OLLAMA_REF_PREFIX = 'ollama/'
const OLLAMA_CLOUD_TAG = /[:-]cloud$/i

export function isLocalModel(model: string | null | undefined, provider?: string | null): boolean {
  const id = (model ?? '').trim()
  const viaRef = id.toLowerCase().startsWith(OLLAMA_REF_PREFIX)
  const viaProvider = provider?.trim().toLowerCase() === 'ollama'
  if (!viaRef && !viaProvider) return false
  return !OLLAMA_CLOUD_TAG.test(viaRef ? id.slice(OLLAMA_REF_PREFIX.length) : id)
}

function getPricing(model: string): { inputPerM: number; outputPerM: number } {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]!
  // Dotted ids (OpenRouter's anthropic/claude-haiku-4.5) match the hyphenated keys.
  const normalized = model.toLowerCase().replace(/\./g, '-')
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== 'default' && normalized.includes(key)) return pricing
  }
  return MODEL_PRICING['default']!
}

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  provider?: string | null,
): number {
  if (isLocalModel(model, provider)) return 0
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
