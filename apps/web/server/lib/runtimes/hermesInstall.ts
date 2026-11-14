// The Hermes branch of `POST /api/runtimes/:id/install`: the pinned release into
// Clawboo's runtimes folder (lib/runtimes/hermes/install.ts), streamed as the
// route's SSE events. Same shape as the npm branch, `(res, d, ctl)`, so the
// route only dispatches.
//
// An install is one job, not one child process, so it is tracked by a marker
// that reads as running until the job ends. A closed panel does not stop it: an
// install switches to the new folder only at its very end, so letting it finish
// is always safe. A gateway still running the previous install is restarted
// onto the new one.

import type { ChildProcess } from 'node:child_process'

import type { Response } from 'express'

import type { RuntimeDescriptor } from './descriptor'
import { hermesGateway, startHermesIfWanted } from './hermes'
import { installHermesRelease, managedHermesCommand } from './hermes/install'

function sendEvent(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export function installHermes(
  res: Response,
  d: RuntimeDescriptor,
  ctl: { child: ChildProcess | null },
): void {
  const marker = { exitCode: null, signalCode: null, killed: true } as unknown as ChildProcess
  ctl.child = marker
  const done = (): void => {
    ;(marker as unknown as { exitCode: number }).exitCode = 0
  }
  void installHermesRelease((ev) => sendEvent(res, ev))
    .then(async ({ version }) => {
      const gw = hermesGateway()
      const state = gw.status().state
      const warnings: string[] = []
      if (state !== 'stopped' && state !== 'not-installed') {
        sendEvent(res, {
          type: 'progress',
          step: 'restart',
          message: 'Restarting the Hermes gateway on the new install…',
        })
        // The install stands either way; a gateway that did not come back is
        // said here, so the panel does not read as all done.
        await gw.restart().catch((err: unknown) => {
          const why = err instanceof Error ? err.message : String(err)
          warnings.push(
            `${d.name} ${version} is installed, but its gateway did not start again: ${why} Start it from the Gateway section of the ${d.name} row.`,
          )
        })
      } else {
        // Hermes agents waiting on an install get their gateway now.
        await startHermesIfWanted('after an install')
      }
      sendEvent(res, { type: 'output', line: `${d.name} ${version} is installed.` })
      done()
      if (!managedHermesCommand()) {
        warnings.push(
          `${d.name} installed, but Clawboo will not run it from its runtimes folder: check the folder's owner and permissions, or set CLAWBOO_RUNTIMES_DIR to a folder of its own.`,
        )
      }
      sendEvent(res, {
        type: 'complete',
        success: true,
        ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
      })
      res.end()
    })
    .catch((err: unknown) => {
      done()
      const code = (err as { code?: unknown }).code
      sendEvent(res, {
        type: 'error',
        code: typeof code === 'string' ? code : 'INSTALL_FAILED',
        message: err instanceof Error ? err.message : String(err),
      })
      res.end()
    })
}
