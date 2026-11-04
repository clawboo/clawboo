// Which way a Hermes run is driven. ACP (`hermes acp`) when this Hermes has it:
// the run streams and takes a steer mid-turn. Otherwise the quiet one-shot path
// (`hermes chat -Q`). A Hermes installed without the `acp` extra fails the ACP
// handshake; the run then falls back by itself, and later runs skip the attempt
// for a while instead of paying for it on every run.
//
// `CLAWBOO_HERMES_TRANSPORT=quiet` keeps every run on the quiet path, and `acp`
// always tries ACP first.
//
// The Runtimes status also asks Hermes directly (`hermes acp --check`), so a
// Hermes without ACP shows before any run has paid for the attempt. A check that
// finds no ACP counts as a run finding it, and an install or update forgets both.

import type { HermesDriver, HermesTransport } from '@clawboo/adapter-hermes'
import type { StartOpts } from '@clawboo/executor'
import { createLogger } from '@clawboo/logger'

import { runHermesAcpCheck } from './hermesAcpCheck'
import { createHermesAcpDriver } from './hermesAcpDriver'
import { createHermesDriver } from './hermesDriver'
import type { RuntimeRunContext } from './types'

const log = createLogger('hermes-transport')

/** How long a Hermes found without ACP is driven quietly before ACP is tried
 *  again (an update in between may have added it). */
export const HERMES_ACP_RECHECK_MS = 10 * 60_000

/** How soon a check that could not tell (a timeout, a crash on a slow start) is
 *  asked again: until then the status can offer no update. */
export const HERMES_ACP_RETRY_MS = 60_000

let acpMissingUntil = 0

const forcedTransport = (): string | undefined =>
  process.env['CLAWBOO_HERMES_TRANSPORT']?.trim().toLowerCase()

/** The transport runs use now. */
export function hermesTransport(now = Date.now()): HermesTransport {
  const forced = forcedTransport()
  if (forced === 'quiet') return 'quiet'
  if (forced === 'acp') return 'acp'
  return now < acpMissingUntil ? 'quiet' : 'acp'
}

/** Remember that this Hermes has no ACP mode. */
export function markHermesAcpMissing(reason: string, now = Date.now()): void {
  if (now >= acpMissingUntil) log.info({ reason }, 'hermes acp unavailable; using the quiet path')
  acpMissingUntil = now + HERMES_ACP_RECHECK_MS
}

/** What the last `hermes acp --check` said (null: it could not tell), and when. */
let acpCheck: { at: number; available: boolean | null } | null = null
let acpCheckRunning: Promise<boolean | null> | null = null
/** Bumped by a reset, so a check started before it never lands after it. */
let acpCheckEpoch = 0

/** Ask this Hermes whether it has ACP, and remember the answer. Joins a check
 *  already running. Never throws. */
export function checkHermesAcp(): Promise<boolean | null> {
  if (acpCheckRunning) return acpCheckRunning
  const epoch = acpCheckEpoch
  const running = runHermesAcpCheck()
    .catch(() => null)
    .then((available) => {
      if (epoch !== acpCheckEpoch) return available
      acpCheck = { at: Date.now(), available }
      if (available === false) markHermesAcpMissing('hermes acp --check: ACP is not installed')
      return available
    })
    .finally(() => {
      if (acpCheckRunning === running) acpCheckRunning = null
    })
  acpCheckRunning = running
  return running
}

/**
 * Whether this Hermes has ACP, from the last check, without waiting: true, false,
 * or null while unknown. Starts a check when there is no answer, when a definite
 * one is older than the recheck window, or when one that could not tell is older
 * than the retry window. Null, with no check, when the operator pinned the quiet
 * path (an update would change nothing).
 */
export function peekHermesAcp(now = Date.now()): boolean | null {
  if (forcedTransport() === 'quiet') return null
  const maxAge = acpCheck?.available === null ? HERMES_ACP_RETRY_MS : HERMES_ACP_RECHECK_MS
  if (!acpCheck || now - acpCheck.at >= maxAge) void checkHermesAcp()
  return acpCheck?.available ?? null
}

/** Forget it all (tests; an install or update of Hermes). */
export function resetHermesTransport(): void {
  acpMissingUntil = 0
  acpCheck = null
  acpCheckRunning = null
  acpCheckEpoch += 1
}

/** The driver for one Hermes run on the transport in use. */
export function createHermesRunDriver(opts: StartOpts, ctx: RuntimeRunContext): HermesDriver {
  const quiet = (): HermesDriver => createHermesDriver(opts, ctx)
  if (hermesTransport() === 'quiet') return quiet()
  return createHermesAcpDriver(opts, ctx, {
    fallback: quiet,
    onAcpUnavailable: (reason) => {
      if (forcedTransport() !== 'acp') markHermesAcpMissing(reason)
    },
  })
}
