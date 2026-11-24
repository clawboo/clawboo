/**
 * apps/web/server/api/systemLive.ts
 *
 * GET (and HEAD) /api/system/live: whether this server is up, in releases after
 * 0.8.0. It needs no sign-in: the access gate and the identity lane both let it
 * through (see @clawboo/gateway-proxy's liveness.ts), so a program running
 * beside the server can poll it without the access token or a signed identity
 * token. That is why it says up and nothing more: no version, no state, nothing
 * about the install. While the server cannot serve (the work folder move at
 * boot) it answers 503 with `{ "ok": false }` instead (lib/workDirMoveGate.ts);
 * a server that is not running does not answer at all. It counts against a
 * rate-limit bucket of its own (lib/rateLimit.ts `livenessLimiter`), never the
 * one the signed-in dashboard shares.
 */
import type { Request, Response } from 'express'

export function systemLiveGET(_req: Request, res: Response): void {
  // Not even the framework's name.
  res.removeHeader('X-Powered-By')
  res.set('Cache-Control', 'no-store').json({ ok: true })
}
