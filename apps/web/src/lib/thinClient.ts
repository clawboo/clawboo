// Is this page a thin client: one whose control client talks to a Clawboo server
// on another origin (`setApiBase('https://host')`)?
//
// Such a page has no OpenClaw Gateway connection of its own, by design. The
// browser's Gateway connection goes through the server's proxy, which
// `resolveProxyGatewayUrl` finds on the page's own origin, and a thin client's
// origin serves no proxy. Its OpenClaw state comes from the server's own
// connection instead (see RuntimesPanel). So code that offers or opens a page
// connection skips a thin client, where having none is normal.
//
// A path prefix (`/clawboo`, from the shell the server serves) is the same origin
// and not a thin client.

import { getApiBase } from '@clawboo/control-client'

/** True when this page's control client points at a server on another origin. */
export function isThinClient(): boolean {
  const base = getApiBase()
  if (!base || typeof window === 'undefined') return false
  try {
    return new URL(base, window.location.href).origin !== window.location.origin
  } catch {
    return false
  }
}
