import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { calculateCostUsd } from '../costUtils'
import { NATIVE_PRICED_MODELS, priceTurn } from '../runtimes/native/pricing'

const M = 1_000_000

// [model id, USD per million input tokens, USD per million output tokens].
// Anthropic list prices as verified on 2026-09-28 at
// https://platform.claude.com/docs/en/about-claude/pricing.
const RATES: ReadonlyArray<readonly [string, number, number]> = [
  ['claude-fable-5-1', 10, 50],
  ['claude-fable-5', 10, 50],
  ['claude-opus-5-5', 4, 20],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-5-20251101', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4-1-20250805', 15, 75],
  ['claude-opus-4-0', 15, 75],
  ['claude-opus-4-20250514', 15, 75],
  ['claude-sonnet-5-5', 2, 10],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-sonnet-4-5', 3, 15],
  ['claude-sonnet-4-5-20250929', 3, 15],
  ['claude-sonnet-4-0', 3, 15],
  ['claude-sonnet-4-20250514', 3, 15],
  ['claude-sonnet-3-7', 3, 15],
  ['claude-3-7-sonnet-20250219', 3, 15],
  ['claude-haiku-4-5', 1, 5],
  ['claude-haiku-4-5-20251001', 1, 5],
  ['claude-haiku-3-5', 0.8, 4],
  ['claude-3-5-haiku-20241022', 0.8, 4],
  ['gpt-4o', 2.5, 10],
  ['gpt-4o-mini', 0.15, 0.6],
  // OpenRouter and dotted ids match the hyphenated keys.
  ['anthropic/claude-haiku-4.5', 1, 5],
  ['anthropic/claude-opus-4.5', 5, 25],
  ['anthropic/claude-opus-4.1', 15, 75],
  ['anthropic/claude-sonnet-5.5', 2, 10],
  ['openai/gpt-4o-mini', 0.15, 0.6],
  ['openai/gpt-4o', 2.5, 10],
  // Unpriced models fall back to the default rate.
  ['gpt-5-codex', 3, 15],
  ['default', 3, 15],
]

describe('calculateCostUsd rate table', () => {
  it.each(RATES)(
    'prices %s at %s USD in and %s USD out per million tokens',
    (model, inPerM, outPerM) => {
      expect(calculateCostUsd(model, M, 0)).toBeCloseTo(inPerM, 9)
      expect(calculateCostUsd(model, 0, M)).toBeCloseTo(outPerM, 9)
    },
  )

  it('prices a million tokens each way at the point rates', () => {
    expect(calculateCostUsd('claude-opus-4-8', M, M)).toBe(30)
    expect(calculateCostUsd('claude-opus-4-1', M, M)).toBe(90)
    expect(calculateCostUsd('claude-sonnet-5', M, M)).toBe(12)
  })

  it('matches the most specific key before a shorter key it contains', () => {
    // claude-opus-4 is a substring of every Opus 4.x id, and claude-opus-5 of Opus 5.5.
    expect(calculateCostUsd('claude-opus-4-5-20251101', M, M)).toBe(30)
    expect(calculateCostUsd('claude-opus-5-5', M, M)).toBe(24)
    expect(calculateCostUsd('CLAUDE-HAIKU-4.5', M, M)).toBe(6)
  })
})

describe('costUtils and native pricing agree', () => {
  it.each(NATIVE_PRICED_MODELS.map((id) => [id]))('prices %s the same in both tables', (id) => {
    const both = priceTurn(id, { inputTokens: M, outputTokens: M }).costUsd
    const inOnly = priceTurn(id, { inputTokens: M, outputTokens: 0 }).costUsd
    const outOnly = priceTurn(id, { inputTokens: 0, outputTokens: M }).costUsd
    expect(both).not.toBeNull()
    expect(calculateCostUsd(id, M, M)).toBeCloseTo(both!, 9)
    expect(calculateCostUsd(id, M, 0)).toBeCloseTo(inOnly!, 9)
    expect(calculateCostUsd(id, 0, M)).toBeCloseTo(outOnly!, 9)
  })
})

describe('the browser copy of costUtils', () => {
  // apps/web/server may not import apps/web/src (eslint boundary), so the
  // browser copy is held to the server copy byte for byte: the same source
  // gives the same prices for every id above.
  it('is byte-identical to the server copy', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const server = readFileSync(path.resolve(here, '../costUtils.ts'), 'utf8')
    const browser = readFileSync(
      path.resolve(here, '../../../src/features/cost/costUtils.ts'),
      'utf8',
    )
    expect(browser).toBe(server)
  })
})
