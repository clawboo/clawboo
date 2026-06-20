// /api/health — the boot probe's HTTP surface, backing the System Health view.
//
// GET returns the latest BootReport (computed once at boot; recomputed on demand if
// the server has not produced one yet). POST /api/health/recheck recomputes fresh
// (the "Re-run probe" button after the user fixes a problem). The response always
// carries `ok` (= no fatal checks) so a simple liveness probe can read one field.

import type { Request, Response } from 'express'

import { getLastBootReport, runBootProbe, type BootReport } from '../lib/bootProbe'
import { readApiPortFile } from '../lib/portUtils'
import { redactObject } from '../lib/redact'

function serialize(report: BootReport): Record<string, unknown> {
  // Dates serialize to ISO via JSON; `ok` is the one-field liveness summary.
  // Redact-on-display (consistent with obs/audit/tools): the boot-report check
  // details derive from err.message + resolved paths — a credential-shaped
  // substring that lands in one is masked, while the readable paths/config stay.
  return redactObject({ ok: report.fatal.length === 0, ...report }) as Record<string, unknown>
}

/** The actual listening port to match the api-port file against. The boot-time
 *  report holds the real one; fall back to the file for a pre-boot GET. */
function resolvePort(): number | undefined {
  return getLastBootReport()?.resolved.apiPort ?? readApiPortFile() ?? undefined
}

export function healthGET(_req: Request, res: Response): void {
  const last = getLastBootReport()
  if (last) {
    res.json(serialize(last))
    return
  }
  // No boot report yet — compute one now so the endpoint is always answerable.
  void runBootProbe({ port: resolvePort() })
    .then((report) => res.json(serialize(report)))
    .catch((err: unknown) =>
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
}

export function healthRecheckPOST(_req: Request, res: Response): void {
  void runBootProbe({ port: resolvePort() })
    .then((report) => res.json(serialize(report)))
    .catch((err: unknown) =>
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
}
