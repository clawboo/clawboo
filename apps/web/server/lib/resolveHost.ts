// Host-binding policy for the dashboard server. Clawboo is a local-first,
// single-user tool: default to loopback (127.0.0.1) so a fresh install is never
// reachable by other hosts on the network. Widen ONLY when the operator
// explicitly sets HOST (e.g. a headless/remote box) — and pair that opt-in with
// the no-token fail-closed refusal in index.ts.
//
// We deliberately do NOT consume HOSTNAME as a bind-widening signal: Docker,
// systemd, and many CI runners auto-inject HOSTNAME into every process env, so
// treating it as "expose me" silently binds a container to its routable IP — a
// non-loopback exposure the operator never chose. Widening must be an explicit
// HOST=.
//
// Extracted into its own module (rather than inlined in index.ts) so it is
// unit-testable: index.ts calls main() at module top level, so importing
// anything from it would boot the whole server.

export const LOOPBACK_HOST = '127.0.0.1'

type Env = Record<string, string | undefined>

/**
 * Resolve the interface to bind. An explicit HOST wins (trimmed); otherwise
 * default to loopback. Returns '127.0.0.1' — NOT '0.0.0.0' — so the dashboard and
 * every /api/* route are loopback-only unless the operator opts into a wider bind
 * with HOST. (HOSTNAME is intentionally ignored — see the module header.)
 */
export function resolveHost(env: Env = process.env): string {
  const fromEnv = env['HOST']?.trim()
  return fromEnv || LOOPBACK_HOST
}

/**
 * Fail-closed gate for a network-exposed dashboard with no auth. Returns true
 * when the server must REFUSE to start: a non-loopback bind, the access-token
 * gate disabled, and no explicit insecure opt-out. The default loopback bind is
 * never refused (isLoopbackHost is true), so the zero-friction CLI / dev / test
 * flows are untouched — only a deliberately network-exposed, token-less bind
 * trips it, and CLAWBOO_ALLOW_INSECURE=1 is the explicit escape hatch. The origin
 * guard is NOT auth here (a non-browser LAN client forges Host/Origin freely), so
 * the access token is the only real auth for a wide bind.
 */
export function shouldRefuseInsecureBind(params: {
  hostname: string
  gateEnabled: boolean
  allowInsecure: boolean
}): boolean {
  return !isLoopbackHost(params.hostname) && !params.gateEnabled && !params.allowInsecure
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
