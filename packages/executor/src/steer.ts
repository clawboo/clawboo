import type { SteerOptions, SteerResult } from './types'

/** The slice of a per-run driver that can take a mid-run message. `steer`
 *  resolves true when the run took it, false when the run has already ended, and
 *  throws when the runtime refused it. */
export interface SteerableDriver {
  steer?(text: string, opts?: SteerOptions): Promise<boolean>
}

/**
 * An adapter's `steer()` over its run's driver: the shape every per-run-driver
 * adapter shares. A missing driver is `no-run`, a driver without `steer` is
 * `unsupported`. Never throws.
 */
export async function steerThroughDriver(
  driver: SteerableDriver | undefined,
  text: string,
  mode: 'live' | 'interrupt-resume',
  opts?: SteerOptions,
): Promise<SteerResult> {
  if (!driver) return { delivered: false, reason: 'no-run' }
  if (!driver.steer) return { delivered: false, reason: 'unsupported' }
  // Stopping a run is never worth it for an FYI.
  if (opts?.passive && mode === 'interrupt-resume')
    return { delivered: false, reason: 'unsupported' }
  try {
    return (await driver.steer(text, opts))
      ? { delivered: true, mode }
      : { delivered: false, reason: 'run-ended' }
  } catch (err) {
    return {
      delivered: false,
      reason: 'rejected',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}
