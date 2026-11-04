/**
 * apps/web/server/api/access.ts
 *
 * POST /api/access/launch-code: a one-time code that signs a browser in.
 *
 * `clawboo open` calls it with the access token as its cookie, then opens
 * `/?access_code=<code>`; the dashboard's "Open on another device" calls it for a
 * link and a QR code. The access gate trades the code for the cookie once, on a
 * page URL, within two minutes, so the token itself never goes into a URL or an
 * opener's arguments. Like every /api/ route it sits behind the gate, so only a
 * caller that already holds the cookie can mint one.
 */
import type { Request, Response } from 'express'

import type { AccessGate } from '@clawboo/gateway-proxy'

/** The gate ../index.ts publishes on `app.locals`. */
function gateOf(req: Request): Pick<AccessGate, 'enabled' | 'mintLaunchCode'> | null {
  const gate = req.app.locals['accessGate'] as
    Pick<AccessGate, 'enabled' | 'mintLaunchCode'> | undefined
  return gate ?? null
}

export function accessLaunchCodePOST(req: Request, res: Response): void {
  res.set('Cache-Control', 'no-store')
  const minted = gateOf(req)?.mintLaunchCode() ?? null
  // No gate, no code: the plain address already opens the dashboard.
  if (minted === null) {
    res.json({ gated: false })
    return
  }
  res.json({
    gated: true,
    code: minted.code,
    expiresAt: minted.expiresAt,
    // Relative, so a browser on a machine whose clock differs can count down.
    expiresInMs: minted.expiresInMs,
  })
}
