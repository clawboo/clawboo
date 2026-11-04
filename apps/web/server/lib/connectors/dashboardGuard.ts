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
// origins and its bind address blocked, built from the port and address this
// server really listens on. Each of those servers says its block is not a
// security boundary, which is why the broker also refuses any connector call
// whose arguments name the dashboard (packages/db/src/tools/inspectors.ts).
// Other loopback ports stay reachable: testing a local app is a normal reason
// to run a browser. Neither layer knows a name that reaches the server through
// a reverse proxy or one listed in CLAWBOO_ALLOWED_HOSTS; there the access
// token is the only check.
//
// Chrome rewrites a URL's host before either server matches it, so most
// spellings need no entry of their own: 127.1, 2130706433, 0x7f000001 and
// 0177.0.0.1 arrive as 127.0.0.1, [0:0:0:0:0:0:0:1] as [::1],
// [::ffff:127.0.0.1] as [::ffff:7f00:1], and upper case, percent escapes,
// full-width characters and a leading zero on the port are undone. Chrome
// keeps a trailing dot on a name, and it sends every name under .localhost to
// loopback itself, without DNS, so those are listed. A public name that
// resolves to 127.0.0.1 reaches the port too; no list can hold them all, and
// the server's origin guard refuses API calls under a Host it does not know.

let dashboardPort: number | null = null
let dashboardBindHost: string | null = null

/** Recorded at boot, once the port is resolved, with the address the server
 *  listens on (`HOST`, 127.0.0.1 by default). */
export function setDashboardPort(port: number, bindHost?: string): void {
  dashboardPort = port
  dashboardBindHost = bindHost ?? null
}

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/

/** Hosts every list below carries, whatever the server is bound to. */
const ALWAYS_LISTED = new Set(['127.0.0.1', '0.0.0.0', '[::1]', '[::]', 'localhost'])

/** The address the server is bound to, as Chrome writes it, when the lists
 *  below do not already carry it: a loopback alias such as 127.0.0.2, or a LAN
 *  address or name. The origin guard trusts it, so it is the dashboard too. */
function boundAddress(bindHost: string | null): string | null {
  const raw = bindHost?.trim()
  if (!raw) return null
  try {
    const bracketed = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
    const host = new URL(`http://${bracketed}`).hostname.replace(/\.$/, '')
    return ALWAYS_LISTED.has(host) ? null : host
  } catch {
    return null
  }
}

/** An IPv4 address the way Chrome writes it as an IPv4-mapped IPv6 host. */
const ipv4Mapped = (ipv4: string): string => new URL(`http://[::ffff:${ipv4}]`).hostname

/** Every host, as Chrome writes it, that reaches the dashboard's port. */
function blockedHosts(style: 'origins' | 'urlPatterns', bindHost: string | null): string[] {
  const bound = boundAddress(bindHost)
  const ipv4 = ['127.0.0.1', ...(bound && IPV4.test(bound) ? [bound] : []), '0.0.0.0']
  return [
    // Playwright reads each origin as a glob over the URL, so `127.*` covers
    // every 127.x.x.x address. The glob does not check that the rest is
    // numeric, so it also refuses a name such as 127.example.com on this port.
    // That is deliberate: such a name on the dashboard's port is rare, and
    // names like 127.0.0.1.nip.io resolve to loopback. Spelling out numeric
    // octets would take a 256-way brace list per octet.
    //
    // A URL pattern cannot say 127/8: its parser reads `127.` as the address
    // 0.0.0.127, and Chrome's network rules ignore a regexp group. So Chrome
    // DevTools blocks 127.0.0.1 and the address the server is bound to, but
    // not the rest of 127/8. The broker's inspector refuses a call that names
    // any 127.x.x.x address, but it reads only call arguments, so a click or a
    // redirect to 127.0.0.2 on a 0.0.0.0 bind is not stopped. There the origin
    // guard answers only the page's GETs (it refuses that Origin on a POST or
    // a WebSocket), and with an access token those get a 401 too.
    ...(style === 'origins' ? ['127.*', ...ipv4.filter((host) => !host.startsWith('127.'))] : ipv4),
    // An IPv4-mapped address connects to the IPv4 listener. Playwright parses
    // each entry as a URL, which rejects a `*` inside brackets, so these are
    // exact, and only the inspector refuses the mapped forms of the rest of
    // 127/8 (the origin guard does not trust them as a Host).
    ...ipv4.map(ipv4Mapped),
    // A bound IPv6 address, or a name, which Chrome keeps with or without a
    // trailing dot.
    ...(bound && !IPV4.test(bound) ? (bound.startsWith('[') ? [bound] : [bound, `${bound}.`]) : []),
    '[::1]',
    '[::]',
    'localhost',
    'localhost.',
    '*.localhost',
    '*.localhost.',
  ]
}

/** URLPattern syntax reads `[`, `:` and other characters as pattern syntax, so
 *  an IPv6 host has to be escaped or the pattern is rejected (and the browser
 *  with it). Every special character is escaped, the escape itself first. */
const escapeUrlPattern = (text: string): string => text.replace(/[\\:[\]{}()*+?]/g, '\\$&')

function toUrlPattern(origin: string): string {
  const m = /^(https?:\/\/)\[([^\]]+)\](.*)$/.exec(origin)
  const escaped = m ? `${m[1]}\\[${escapeUrlPattern(m[2]!)}\\]${m[3]}` : origin
  return `${escaped}/*`
}

/** Launch arguments that block the dashboard, in the form this browser takes. */
export function blockDashboardArgs(
  spec: { flag: string; style: 'origins' | 'urlPatterns' } | undefined,
  port: number | null = dashboardPort,
  bindHost: string | null = dashboardBindHost,
): string[] {
  if (!spec || port === null) return []
  const origins = blockedHosts(spec.style, bindHost).map((host) => `http://${host}:${port}`)
  if (spec.style === 'origins') return [spec.flag, origins.join(';')]
  return origins.flatMap((origin) => [spec.flag, toUrlPattern(origin)])
}
