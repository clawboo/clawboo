// What a stop of the server waits for before it exits: every runtime child it
// started, and the Hermes gateway's planned stop, side by side.
//
// - Runtime children get SIGTERM to their whole tree, with killTree's SIGKILL
//   3 s later, and a wait of up to `SHUTDOWN_WAIT_MS` (5 s) for them to go.
// - The Hermes gateway is not among them: it gets SIGINT, the stop Hermes reads
//   as planned (a bare SIGTERM reads as a crash), up to
//   `CLAWBOO_HERMES_STOP_GRACE_MS` (5 s by default, never more than 8 s) to
//   exit, then SIGKILL and up to 1 s more.
//
// The two waits run AT THE SAME TIME, so the whole stop takes the longer of
// them (about 9 s at most), not their sum: well inside the 15 s an app that
// runs Clawboo may allow a stop before it ends the process. With no gateway
// started the Hermes side waits for nothing.

import { stopHermesGatewayForExit } from './hermes'
import { shutdownLiveSubprocesses } from './subprocess'

export interface ExitStopLog {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
}

export interface ExitStopOptions {
  /** How long to wait for the runtime children (default `SHUTDOWN_WAIT_MS`). */
  childWaitMs?: number
  /** Where `CLAWBOO_HERMES_STOP_GRACE_MS` is read (default `process.env`). */
  env?: NodeJS.ProcessEnv
}

/** Stop every runtime child and the Hermes gateway, and wait (bounded) for
 *  both. Never rejects. */
export async function stopRuntimesForExit(
  log: ExitStopLog,
  opts: ExitStopOptions = {},
): Promise<void> {
  // The gateway's SIGINT goes out first: the child reap below can spend a
  // moment in `ps` (a walk of each child not spawned as a group leader) before
  // its own wait begins, and the grace should not start late for it.
  const hermes = (async () => {
    try {
      const outcome = await stopHermesGatewayForExit(opts.env)
      if (outcome !== 'not-running') log.info({ outcome }, 'Stopped the Hermes gateway on shutdown')
    } catch (err) {
      log.warn({ err }, 'Failed to stop the Hermes gateway on shutdown (non-fatal)')
    }
  })()
  const children = (async () => {
    try {
      const { signalled, exited } = await shutdownLiveSubprocesses(opts.childWaitMs)
      if (signalled > 0) {
        log.info({ signalled, exited }, 'Terminated running runtime subprocesses on shutdown')
      }
    } catch (err) {
      log.warn({ err }, 'Failed to terminate runtime subprocesses on shutdown (non-fatal)')
    }
  })()
  await Promise.all([hermes, children])
}
