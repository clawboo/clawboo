// Did the dashboard's own page send this request?
//
// A browser stamps fetch metadata on every request and a page cannot change it.
// `Sec-Fetch-Site: same-origin` says the dashboard's origin sent it (the dev
// server's proxy passes the header through), and `Sec-Fetch-Mode: cors` (what
// fetch() uses by default) or `same-origin` says a script on that page called
// fetch(), not a link or a form. A CLI, an agent's curl or any other local
// program sends neither unless it writes them by hand.
//
// A browser sends fetch metadata only to a secure address, which `localhost` and
// https are. On plain http to another machine's address (the documented network
// bind, a phone on the same network) it sends none, but it does send `Origin` on
// every write. So with no fetch metadata at all, a write whose Origin is that kind
// of address and names the host it was sent to is the dashboard's page too.
//
// A speed bump, NOT a security boundary. Any program running as the same user
// can send these headers, and can write the SQLite database under ~/.clawboo
// directly anyway. What it stops is a local caller passing for the person by
// setting one body field.

import type { IncomingMessage } from 'node:http'

function header(req: IncomingMessage, name: string): string {
  const value = req.headers?.[name]
  return (Array.isArray(value) ? (value[0] ?? '') : (value ?? '')).trim().toLowerCase()
}

/** Addresses a browser treats as secure over plain http: it sends them fetch
 *  metadata, so a write to one without it did not come from a browser's page. */
function isLoopbackName(hostname: string): boolean {
  const name = hostname.toLowerCase()
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(name)
  )
}

/** A write from a page on a plain http address, where a browser sends no metadata. */
function isInsecureOriginWrite(req: IncomingMessage): boolean {
  let origin: URL
  try {
    origin = new URL(header(req, 'origin'))
  } catch {
    return false
  }
  return (
    origin.protocol === 'http:' &&
    !isLoopbackName(origin.hostname) &&
    origin.host === header(req, 'host')
  )
}

export function isDashboardRequest(req: IncomingMessage): boolean {
  const site = header(req, 'sec-fetch-site')
  const mode = header(req, 'sec-fetch-mode')
  if (!site && !mode) return isInsecureOriginWrite(req)
  if (site !== 'same-origin') return false
  return mode === 'cors' || mode === 'same-origin'
}
