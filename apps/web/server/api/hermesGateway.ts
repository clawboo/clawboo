// ─── Hermes gateway status + control ──────────────────────────
// GET  /api/runtimes/hermes/gateway                      → its status
// POST /api/runtimes/hermes/gateway { action: 'start' | 'restart' | 'stop' }
//
// The Runtimes card's Gateway section for Hermes, like OpenClaw's. Clawboo
// supervises this gateway itself (it starts on demand and stops with Clawboo),
// so these are a person's manual controls; nothing here returns a key.

import type { Request, Response } from 'express'

import { hermesGateway } from '../lib/runtimes/hermes'

export function hermesGatewayGET(_req: Request, res: Response): void {
  res.json(hermesGateway().status())
}

export async function hermesGatewayPOST(req: Request, res: Response): Promise<void> {
  const action = (req.body as { action?: unknown } | undefined)?.action
  if (action !== 'start' && action !== 'restart' && action !== 'stop') {
    res.status(400).json({ error: "action must be 'start', 'restart' or 'stop'" })
    return
  }
  const gw = hermesGateway()
  try {
    if (action === 'stop') await gw.stop()
    else if (action === 'restart') await gw.restart()
    else await gw.ensureRunning()
    res.json({ ok: true, status: gw.status() })
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: gw.status(),
    })
  }
}
