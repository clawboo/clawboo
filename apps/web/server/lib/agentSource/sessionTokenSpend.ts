// Real token spend for an OpenClaw agent, one turn at a time.
//
// WHY SUMMING IS CORRECT, and not a workaround. Every request re-sends the whole
// conversation, so the provider bills the full prompt on each one. A turn's
// `inputTokens` IS that turn's charge, and adding the turns gives the genuine
// total. Confirmed against live sessions where the figure sits both well below
// and well above `totalTokens` (866 against 20573, and 51477 against 25775),
// which a running total could do in neither direction.
//
// WHAT THIS REPLACES. clawboo recorded cost from the BROWSER, with the model as
// the literal string "unknown" and the prompt size guessed by dividing the
// transcript's character count by four. Across 137 rows that produced 185 input
// tokens in total, against a single real request of 27,287. No model meant no
// price, so every dollar figure on the dashboard was zero.
//
// THE ONE HAZARD is counting a turn twice. Several message frames land per turn
// and each carries the same session snapshot, so a naive writer would bill one
// request once per message. Recording only when the numbers CHANGE is what makes
// the total true rather than merely large.

import { createLogger } from '@clawboo/logger'

const log = createLogger('token-spend')

/** Enough for a fleet's live sessions; a stale entry costs one skipped turn. */
const MAX_SESSIONS = 500

export interface TurnSpend {
  model: string
  inputTokens: number
  outputTokens: number
}

export interface SpendSnapshot {
  model?: string | undefined
  inputTokens?: number | undefined
  outputTokens?: number | undefined
}

/**
 * Decides whether a snapshot represents a turn not yet billed.
 *
 * SEEDED, NOT ASSUMED EMPTY. On a restart an unseeded tracker treats the first
 * frame of every live session as a fresh turn and bills it again, which is the
 * one way this design can OVER-count. The caller seeds it from what is already
 * recorded, so a restart mid-conversation resumes rather than repeats.
 */
export class SessionTokenSpend {
  private readonly lastSeen = new Map<string, string>()

  /** Prime a session with spend already recorded, so it is not billed twice. */
  seed(sessionKey: string, spend: TurnSpend): void {
    this.remember(sessionKey, this.signature(spend))
  }

  /**
   * The turn to bill for this frame, or null when there is nothing new.
   *
   * Null covers three cases that all mean "do not write a row": the frame
   * carries no usage at all, it carries the same numbers as the last one (the
   * other messages of a turn already billed), or the counts are zero.
   */
  take(sessionKey: string, snapshot: SpendSnapshot): TurnSpend | null {
    const { model, inputTokens, outputTokens } = snapshot
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null
    if (inputTokens <= 0 && outputTokens <= 0) return null

    const spend: TurnSpend = {
      // A real name or nothing. "unknown" was what made every price zero, so
      // writing it again would rebuild the exact fiction this removes.
      model: typeof model === 'string' && model.length > 0 ? model : '',
      inputTokens,
      outputTokens,
    }
    if (!spend.model) return null

    const sig = this.signature(spend)
    if (this.lastSeen.get(sessionKey) === sig) return null
    this.remember(sessionKey, sig)
    log.debug({ sessionKey, ...spend }, 'billing a turn')
    return spend
  }

  /** Test seam. Forgetting mid-conversation re-bills the next turn. */
  reset(): void {
    this.lastSeen.clear()
  }

  private signature(s: TurnSpend): string {
    return `${s.model}|${s.inputTokens}|${s.outputTokens}`
  }

  private remember(sessionKey: string, sig: string): void {
    if (this.lastSeen.size >= MAX_SESSIONS && !this.lastSeen.has(sessionKey)) {
      const oldest = this.lastSeen.keys().next().value
      if (oldest !== undefined) this.lastSeen.delete(oldest)
    }
    this.lastSeen.set(sessionKey, sig)
  }
}
