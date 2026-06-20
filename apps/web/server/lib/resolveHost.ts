// Host-binding policy for the dashboard server. Clawboo is a local-first,
// single-user tool: default to loopback (127.0.0.1) so a fresh install is never
// reachable by other hosts on the network. Widen ONLY when the operator
// explicitly sets HOST/HOSTNAME (e.g. a headless/remote box) — and pair that
// opt-in with the no-token exposure warning in index.ts.
//
// Extracted into its own module (rather than inlined in index.ts) so it is
// unit-testable: index.ts calls main() at module top level, so importing
// anything from it would boot the whole server.

export const LOOPBACK_HOST = '127.0.0.1'

type Env = Record<string, string | undefined>

/**
 * Resolve the interface to bind. An explicit HOST/HOSTNAME wins (trimmed);
 * otherwise default to loopback. Returns '127.0.0.1' — NOT '0.0.0.0' — so the
 * dashboard and every /api/* route are loopback-only unless the operator opts
 * into a wider bind.
 */
export function resolveHost(env: Env = process.env): string {
  const fromEnv = env['HOST']?.trim() || env['HOSTNAME']?.trim()
  return fromEnv || LOOPBACK_HOST
}

/**
 * True when `host` binds only the local machine — IPv4 loopback (127.0.0.0/8),
 * IPv6 loopback (::1), or the literal 'localhost'. Anything else ('0.0.0.0',
 * '::', a LAN IP, a hostname) is network-exposed, which is exactly the trigger
 * for the no-token boot warning.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '') // strip [..] from IPv6 literals
  if (h === 'localhost') return true
  if (h === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
}
