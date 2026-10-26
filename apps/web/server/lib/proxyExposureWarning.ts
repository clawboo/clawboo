import type { IncomingMessage } from 'node:http'

import { isForwardedRequest } from '@clawboo/gateway-proxy'

/**
 * Warn, once, when a reverse proxy forwards to a server running with no access token.
 *
 * The bind check cannot see this. Behind a same-host proxy the server binds loopback,
 * so it starts without complaint, while every request the proxy forwards arrives from
 * 127.0.0.1 and every /api/* route is open to whoever can reach the proxy. The first
 * forwarded request is the earliest moment the server can know.
 *
 * Log-only, never a refusal: an operator who authenticates at the proxy (basic auth,
 * an SSO proxy, Cloudflare Access) is doing nothing wrong, and blocking would break
 * them. Not a boot-probe check either, because the probe is a snapshot taken at boot,
 * before any request has arrived.
 */
export function createProxyExposureWarning(opts: {
  gateEnabled: boolean
  warn: (message: string) => void
}): (req: IncomingMessage) => void {
  let done = opts.gateEnabled
  return (req) => {
    if (done || !isForwardedRequest(req)) return
    done = true
    opts.warn(
      'SECURITY: a request reached this server through a reverse proxy (it carried a ' +
        'Forwarded / X-Forwarded-* / X-Real-IP header), and STUDIO_ACCESS_TOKEN is not set. ' +
        'The proxy delivers every request from 127.0.0.1, so the dashboard and every /api/* ' +
        'route are open to anyone who can reach it. Set STUDIO_ACCESS_TOKEN, or make sure ' +
        'the proxy authenticates every request. (Logged once per process.)',
    )
  }
}
