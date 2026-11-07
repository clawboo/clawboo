// Drain and hold, for whatever stops or restarts this engine: `clawboo stop`, a
// desktop app's updater, a process manager's stop script.
//
//   GET    /api/system/hold         whether the engine is held, by whom, and
//                                   whether agent runs are still going
//   POST   /api/system/hold         place or renew a hold: { owner, ttlSeconds?, reason? }
//   DELETE /api/system/hold/:owner  release that owner's hold
//
// The drain is: POST a hold, read GET until `backgroundWork` is `none` (renewing
// the hold before it lapses), then stop. Release the hold instead to cancel. See
// lib/engineHold for what a hold stops and lib/runSlots for what counts as a run. A
// work check counts too: it holds no run slot, and a restart would cut it short.

import type { Request, Response } from 'express'

import {
  HOLD_OWNER_RE,
  HOLD_REASON_MAX,
  HOLD_TTL_DEFAULT_MS,
  HOLD_TTL_MAX_MS,
  HOLD_TTL_MIN_MS,
  SELF_UPDATE_HOLD_OWNER,
  engineHold,
} from '../lib/engineHold'
import { runSlots } from '../lib/runSlots'
import { teamChecksInFlight } from '../lib/teamChat/teamOrchestrator'

export interface EngineHoldState {
  /** True while any hold is live: no new agent run starts. */
  held: boolean
  holds: {
    owner: string
    reason: string | null
    heldAt: number
    expiresAt: number
    /** Time to `expiresAt` on this server's clock, for a caller whose clock differs. */
    expiresInMs: number
  }[]
  /** `present` while an agent run is executing, or a work check is under way or holding;
   *  `none` when stopping now cuts none of them short. */
  backgroundWork: 'present' | 'none'
  runs: {
    /** Agent runs executing now. */
    running: number
    /** Runs waiting to start. While the engine is held they do not start. */
    queued: number
    /** The cap on runs executing at once (CLAWBOO_MAX_CONCURRENT_RUNS). */
    limit: number
  }
}

export function engineHoldState(): EngineHoldState {
  const now = Date.now()
  const holds = engineHold()
    .list()
    .map((h) => ({ ...h, expiresInMs: Math.max(0, h.expiresAt - now) }))
  const { size, running, queued } = runSlots().stats()
  return {
    held: holds.length > 0,
    holds,
    backgroundWork: running > 0 || teamChecksInFlight() > 0 ? 'present' : 'none',
    runs: { running, queued, limit: size },
  }
}

export function systemHoldGET(_req: Request, res: Response): void {
  res.json(engineHoldState())
}

const TTL_SECONDS_MIN = HOLD_TTL_MIN_MS / 1000
const TTL_SECONDS_MAX = HOLD_TTL_MAX_MS / 1000

export function systemHoldPOST(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { owner?: unknown; ttlSeconds?: unknown; reason?: unknown }
  const owner = body.owner
  if (typeof owner !== 'string' || !HOLD_OWNER_RE.test(owner)) {
    res.status(400).json({
      error:
        'owner must be 1 to 128 letters, digits or . _ : @ -, starting with a letter or digit.',
    })
    return
  }
  // The update's own hold ends with the update; another holder under its id
  // would be released by it, and could release it.
  if (owner === SELF_UPDATE_HOLD_OWNER) {
    res.status(400).json({ error: `${owner} is the in-app update's own owner id. Pick another.` })
    return
  }
  let ttlMs = HOLD_TTL_DEFAULT_MS
  if (body.ttlSeconds !== undefined) {
    const ttl = body.ttlSeconds
    if (
      typeof ttl !== 'number' ||
      !Number.isInteger(ttl) ||
      ttl < TTL_SECONDS_MIN ||
      ttl > TTL_SECONDS_MAX
    ) {
      res.status(400).json({
        error: `ttlSeconds must be a whole number from ${TTL_SECONDS_MIN} to ${TTL_SECONDS_MAX}.`,
      })
      return
    }
    ttlMs = ttl * 1000
  }
  let reason: string | undefined
  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string' || body.reason.trim().length > HOLD_REASON_MAX) {
      res
        .status(400)
        .json({ error: `reason must be text of at most ${HOLD_REASON_MAX} characters.` })
      return
    }
    reason = body.reason.trim()
  }
  engineHold().place(owner, { ttlMs, reason: reason === undefined ? undefined : reason || null })
  res.json(engineHoldState())
}

export function systemHoldDELETE(req: Request, res: Response): void {
  const owner = String(req.params['owner'] ?? '')
  if (owner === SELF_UPDATE_HOLD_OWNER) {
    res.status(403).json({
      error: `${owner} is the in-app update's own hold. It ends with the update.`,
    })
    return
  }
  if (!engineHold().release(owner)) {
    res.status(404).json({
      error:
        'No hold is placed under that owner id. Only the owner that placed a hold releases it.',
    })
    return
  }
  res.json(engineHoldState())
}
