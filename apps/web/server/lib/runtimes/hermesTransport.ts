// Which way a Hermes run is driven. ACP (`hermes acp`) when this Hermes has it:
// the run streams and takes a steer mid-turn. Otherwise the quiet one-shot path
// (`hermes chat -Q`). A Hermes installed without the `acp` extra fails the ACP
// handshake; the run then falls back by itself, and later runs skip the attempt
// for a while instead of paying for it on every run.
//
// `CLAWBOO_HERMES_TRANSPORT=quiet` keeps every run on the quiet path, and `acp`
// always tries ACP first.

import type { HermesDriver, HermesTransport } from '@clawboo/adapter-hermes'
import type { StartOpts } from '@clawboo/executor'
import { createLogger } from '@clawboo/logger'

import { createHermesAcpDriver } from './hermesAcpDriver'
import { createHermesDriver } from './hermesDriver'
import type { RuntimeRunContext } from './types'

const log = createLogger('hermes-transport')

/** How long a Hermes found without ACP is driven quietly before ACP is tried
 *  again (an update in between may have added it). */
export const HERMES_ACP_RECHECK_MS = 10 * 60_000

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

/** Forget it (tests; an install or update of Hermes). */
export function resetHermesTransport(): void {
  acpMissingUntil = 0
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
