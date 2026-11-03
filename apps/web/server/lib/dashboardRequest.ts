// Did the dashboard's own page send this request?
//
// A browser stamps fetch metadata on every request and a page cannot change it.
// `Sec-Fetch-Site: same-origin` says the dashboard's origin sent it (the dev
// server's proxy passes the header through), and `Sec-Fetch-Mode: cors` (what
// fetch() uses by default) or `same-origin` says a script on that page called
// fetch(), not a link or a form. A CLI, an agent's curl or any other local
// program sends neither unless it writes them by hand.
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

export function isDashboardRequest(req: IncomingMessage): boolean {
  if (header(req, 'sec-fetch-site') !== 'same-origin') return false
  const mode = header(req, 'sec-fetch-mode')
  return mode === 'cors' || mode === 'same-origin'
}
