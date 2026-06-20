import type { Request } from 'express'

/**
 * The loopback base URL a spawned runtime's MCP client attaches to (this server's
 * `/api/mcp/*` endpoints).
 *
 * Resolved from the server's own bound port (`app.locals.apiPort`, set at boot),
 * NEVER from the client `Host` header. A forged `Host` must not be able to redirect
 * a spawned runtime's Tasks/Memory/Tools/TeamChat traffic to an attacker-controlled
 * server. This mirrors exactly what the boot/ticker callers use
 * (`http://127.0.0.1:${port}`).
 *
 * Returns null when the port isn't known (e.g. a test that didn't set it) — callers
 * treat a null base URL as "attach no MCP" rather than trusting untrusted input.
 */
export function loopbackMcpBaseUrl(req: Request): string | null {
  const apiPort = req.app?.locals?.['apiPort']
  return typeof apiPort === 'number' ? `http://127.0.0.1:${apiPort}` : null
}
