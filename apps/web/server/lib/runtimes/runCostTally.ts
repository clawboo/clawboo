// What one run cost, priced once when the run ends. The drain feeds every
// runtime event to `observe` and calls `settle` on the run's terminal (done, a
// fatal error, or a stream that died with no terminal).
//
// Order of preference: USD the runtime reported, then exact usage tokens priced
// at the model the events name (or the agent's configured model), then a guess
// from character counts. `unbilledUsd` is the part no cost event already charged
// to the budgets, so the caller charges only that much at the terminal.

import type { RunCostSource } from '@clawboo/board-core'
import type { RuntimeEvent } from '@clawboo/executor'

import { estimateRunCostUsd, estimateRunCostUsdFromUsage } from './estimateCost'

export interface SettledRunCost {
  costUsd: number
  costSource: RunCostSource
  /** Summed usage tokens from the cost events, or null when none reported tokens. */
  inputTokens: number | null
  outputTokens: number | null
  /** The part of `costUsd` that no cost event charged to the budgets. */
  unbilledUsd: number
}

export interface RunCostFallback {
  /** The agent's configured model, used only when no event names one. */
  model: string | null
  inputChars: number
  outputChars: number
}

export interface RunCostTally {
  observe(ev: RuntimeEvent): void
  settle(fallback: RunCostFallback): SettledRunCost
}

export function createRunCostTally(): RunCostTally {
  let eventUsd = 0
  let doneUsd = 0
  let sawReported = false
  let sawCostEvent = false
  let flaggedEstimate = false
  let unpricedIn = 0
  let unpricedOut = 0
  let tokensIn = 0
  let tokensOut = 0
  let sawTokens = false
  let model: string | null = null

  return {
    observe(ev) {
      if (ev.kind === 'cost') {
        sawCostEvent = true
        if (ev.model) model = ev.model
        const usage = ev.usage
        if (usage && usage.inputTokens + usage.outputTokens > 0) {
          sawTokens = true
          tokensIn += usage.inputTokens
          tokensOut += usage.outputTokens
        }
        if (ev.costUsd != null) {
          eventUsd += ev.costUsd
          sawReported = true
          if (ev.estimated) flaggedEstimate = true
        } else if (usage) {
          unpricedIn += usage.inputTokens
          unpricedOut += usage.outputTokens
        }
        return
      }
      // A done repeats the cost event (Claude Code) or totals native's per-turn
      // deltas, so its USD is read only when no cost event came. Its usage is
      // never read: native's is point-in-time, not a total.
      if (ev.kind === 'done' && !sawCostEvent && ev.costUsd != null) {
        doneUsd = ev.costUsd
        sawReported = true
      }
    },

    settle(fb) {
      const tokens = sawTokens
        ? { inputTokens: tokensIn, outputTokens: tokensOut }
        : { inputTokens: null, outputTokens: null }
      if (unpricedIn + unpricedOut > 0) {
        const est = estimateRunCostUsdFromUsage({
          model: model ?? fb.model,
          inputTokens: unpricedIn,
          outputTokens: unpricedOut,
        })
        return {
          costUsd: eventUsd + est,
          costSource: 'token-estimate',
          ...tokens,
          unbilledUsd: est,
        }
      }
      if (sawReported) {
        return {
          costUsd: eventUsd + doneUsd,
          costSource: flaggedEstimate ? 'token-estimate' : 'reported',
          ...tokens,
          unbilledUsd: doneUsd,
        }
      }
      const usd = estimateRunCostUsd({
        model: model ?? fb.model,
        inputChars: fb.inputChars,
        outputChars: fb.outputChars,
      })
      return {
        costUsd: usd,
        costSource: 'char-estimate',
        inputTokens: null,
        outputTokens: null,
        unbilledUsd: usd,
      }
    },
  }
}
