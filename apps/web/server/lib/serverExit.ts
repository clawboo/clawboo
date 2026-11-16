// What a graceful stop of the server does before its last synchronous cleanup
// (port file, start marker, database checkpoint), however the stop was asked
// for and whenever the signal came.
//
// 1. Stop what starts new work, at once: hold the engine (no run slot is
//    granted, the board's dispatch pump skips its passes), then stop the
//    routines ticker, the approval reaper and the MCP supervisor. No run starts
//    while the server waits for its runs to end; one that did would only be
//    killed as it registered, and leave its task claimed until the next boot.
// 2. Then, side by side, each bounded: close the OpenClaw connection; stop
//    every runtime child and give the Hermes gateway its planned stop
//    (`stopRuntimesForExit`, about 9 s at most).
// 3. Then flush the trace exporter (2 s at most). Only after the runtimes: a
//    run those stops end closes its span as its process exits, and the trace
//    SDK drops a span that ends once its shutdown has begun. The whole wait is
//    about 11 s at most, inside the 15 s an app that runs Clawboo may allow a
//    stop.
//
// Each of these parts used to stop itself from a `process.once('SIGTERM')` of
// its own. The OpenClaw registry wired one at module load, so a SIGTERM sent
// while the server was still booting reached it before the registry existed and
// spent it: the real stop then never closed the connection, and the server,
// with a listener taking the signal, ran on. The others had the same gap for a
// signal between their start and the stop's. Now nothing but the server's stop
// listens (`watchStopSignals`, which keeps a boot-time signal for the stop), and
// the stop calls each part here.

import { stopRegistry } from './agentSource/registry'
import { stopApprovalReaper } from './approvalReaper'
import { engineHold, HOLD_TTL_DEFAULT_MS, SERVER_STOP_HOLD_OWNER } from './engineHold'
import { stopMcpSupervisor } from './mcpSupervisor'
import { shutdownOtel } from './obs/otel'
import { stopRoutinesTicker } from './routines/ticker'
import { stopRuntimesForExit, type ExitStopLog, type ExitStopOptions } from './runtimes/exitStop'

/** Stop the server's parts for a graceful stop, and wait (bounded) for them.
 *  Never rejects. */
export async function stopServerParts(log: ExitStopLog, opts: ExitStopOptions = {}): Promise<void> {
  const starters: [string, () => void][] = [
    // In memory: it ends with the process, so the next start is not held.
    [
      'engine hold',
      () => {
        engineHold().place(SERVER_STOP_HOLD_OWNER, { ttlMs: HOLD_TTL_DEFAULT_MS, reason: 'stop' })
      },
    ],
    ['routines ticker', stopRoutinesTicker],
    ['approval reaper', stopApprovalReaper],
    ['MCP supervisor', stopMcpSupervisor],
  ]
  for (const [part, stop] of starters) {
    try {
      stop()
    } catch (err) {
      log.warn({ err, part }, 'Failed to stop a part of the server on shutdown (non-fatal)')
    }
  }
  await Promise.all([stopRegistry(), stopRuntimesForExit(log, opts)])
  await shutdownOtel()
}
