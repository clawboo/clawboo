// Keep agents' browsers off the Clawboo dashboard.
//
// The dashboard answers on loopback with no access check (the access gate is
// off there, and a page it serves passes its own same-origin check). A browser
// connector drives a real browser on this machine, so an agent could open the
// dashboard in it and click: approve its own requests, or give itself
// connectors. Once a remembered approval could stand in for the prompt on a
// navigate or a click, nothing would stand in the way.
//
// So both browser connectors are launched with the dashboard's loopback
// origins blocked, built from the port this server really listens on. Each of
// those servers says its block is not a security boundary, which is why the
// broker also refuses any connector call whose arguments name the dashboard
// (packages/db/src/tools/inspectors.ts). Other loopback ports stay reachable:
// testing a local app is a normal reason to run a browser.

let dashboardPort: number | null = null

/** Recorded at boot, once the port is resolved. */
export function setDashboardPort(port: number): void {
  dashboardPort = port
}

/** The spellings that reach a server listening on this machine's loopback. */
export function dashboardLoopbackOrigins(port: number | null = dashboardPort): string[] {
  if (port === null) return []
  return ['127.0.0.1', 'localhost', 'localhost.', '[::1]', '0.0.0.0'].map(
    (host) => `http://${host}:${port}`,
  )
}

/** URLPattern syntax reads `[` and `:` as pattern characters, so an IPv6 host
 *  has to be escaped or the pattern is rejected (and the browser with it). */
function toUrlPattern(origin: string): string {
  const m = /^(https?:\/\/)\[([^\]]+)\](.*)$/.exec(origin)
  const escaped = m ? `${m[1]}\\[${m[2]!.replace(/:/g, '\\:')}\\]${m[3]}` : origin
  return `${escaped}/*`
}

/** Launch arguments that block the dashboard, in the form this browser takes. */
export function blockDashboardArgs(
  spec: { flag: string; style: 'origins' | 'urlPatterns' } | undefined,
  port: number | null = dashboardPort,
): string[] {
  const origins = dashboardLoopbackOrigins(port)
  if (!spec || origins.length === 0) return []
  if (spec.style === 'origins') return [spec.flag, origins.join(';')]
  return origins.flatMap((origin) => [spec.flag, toUrlPattern(origin)])
}
