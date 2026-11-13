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
// security boundary, and Playwright's does not see a redirect hop or a
// WebSocket: a local page that answered 302 to the dashboard loaded it. So
// Chrome itself is also given host rules that look the same hosts up, on the
// dashboard's port, as names that do not exist. That acts on every address the
// browser looks up, whoever starts the request. A proxy server looks addresses
// up itself, so a request Chrome sends through one is not covered. Chrome keeps
// loopback addresses off a proxy by default, so that leaves a dashboard reached
// at a network address in HOST. The broker also refuses any connector
// call whose arguments name the dashboard (packages/db/src/tools/inspectors.ts).
// Other loopback ports stay reachable: testing a local app is a normal reason
// to run a browser. No layer knows a name that reaches the server through a
// reverse proxy or one listed in CLAWBOO_ALLOWED_HOSTS; there the access token
// is the only check.
//
// A browser can also open a file on this computer, such as the access token,
// and that is not a network request. Chrome DevTools is told to refuse file:
// and view-source: URLs; Playwright refuses file: itself, and the broker
// refuses a `url` argument that opens a file in either.
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

import { readBounded, writeAtomic } from '../../agentHost/fsOps'
import { isAgentUserMode } from '../agentUser/config'

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
function blockedHosts(
  style: 'origins' | 'urlPatterns' | 'hostRules',
  bindHost: string | null,
): string[] {
  const bound = boundAddress(bindHost)
  const ipv4 = ['127.0.0.1', ...(bound && IPV4.test(bound) ? [bound] : []), '0.0.0.0']
  const not127 = ipv4.filter((host) => !host.startsWith('127.'))
  return [
    // Playwright reads each origin as a glob over the URL, and a host rule is a
    // glob over the host, so `127.*` covers every 127.x.x.x address. The glob
    // does not check that the rest is numeric, so it also refuses a name such
    // as 127.example.com on this port. That is deliberate: such a name on the
    // dashboard's port is rare, and names like 127.0.0.1.nip.io resolve to
    // loopback. Spelling out numeric octets would take a 256-way brace list
    // per octet.
    //
    // A URL pattern cannot say 127/8: its parser reads `127.` as the address
    // 0.0.0.127, and Chrome's network rules ignore a regexp group. So Chrome
    // DevTools' own block covers 127.0.0.1 and the address the server is bound
    // to, and its host rules cover the rest of 127/8.
    ...(style === 'urlPatterns' ? ipv4 : ['127.*', ...not127]),
    // An IPv4-mapped address connects to the IPv4 listener. Playwright parses
    // each entry as a URL, which rejects a `*` inside brackets, so its entries
    // are exact; a host rule takes the glob, which covers mapped 127/8.
    ...(style === 'hostRules' ? ['[::ffff:7f*]', ...not127.map(ipv4Mapped)] : ipv4.map(ipv4Mapped)),
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

/** Chrome DevTools takes URL patterns, so it is told to refuse local files
 *  too. `view-source:` shows the file it wraps. Playwright refuses `file:`
 *  itself, and the broker refuses a `url` argument that opens a file in
 *  either browser. */
function localFileArgs(spec: { flag: string; style: 'origins' | 'urlPatterns' } | undefined) {
  return spec?.style === 'urlPatterns' ? [spec.flag, 'file:*', spec.flag, 'view-source:*'] : []
}

/** Write the file only when it differs, through a rename, so a browser that
 *  starts at the same moment never reads half of it, and an edited file is
 *  put back before the next browser reads it. */
function writeIfChanged(file: string, body: string): void {
  if (isAgentUserMode()) {
    // In a folder of this server's under the shared temporary folder: read
    // without following a link, and written by a fresh random name (never one
    // anybody could have planted a link at) with exactly 0644, whatever the
    // umask, so the agent user can read it.
    try {
      if (readBounded(file, 64 * 1024).data.toString('utf8') === body) return
    } catch {
      // Not written yet, or not a plain file: write it.
    }
    writeAtomic(file, Buffer.from(body, 'utf8'), 0o644)
    return
  }
  try {
    if (fs.readFileSync(file, 'utf8') === body) return
  } catch {
    // Not written yet.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, { mode: 0o644 })
  fs.renameSync(tmp, file)
}

/**
 * Chrome host rules that look every dashboard host up, on the dashboard's port,
 * as a name that does not exist. They act wherever Chrome looks an address up:
 * a first load, a redirect hop, a script's request or a WebSocket, all fail
 * with ERR_NAME_NOT_RESOLVED. A request sent through a proxy server is looked
 * up by the proxy instead (see the top of this file). Each rule names the
 * port, so the same hosts on other ports stay reachable, and a dashboard on
 * port 80 or 443 does not take the whole web with it.
 */
function networkRuleArgs(
  slug: string,
  spec: { flag: string; style: 'joined' | 'playwrightConfig' } | undefined,
  port: number | null,
  bindHost: string | null,
): string[] {
  if (!spec || port === null) return []
  const rules = blockedHosts('hostRules', bindHost).map((host) => `MAP ${host}:${port} ~NOTFOUND`)
  const chromeSwitch = `--host-resolver-rules=${rules.join(', ')}`
  // Joined, so the switch cannot be read as a flag of the server's own.
  if (spec.style === 'joined') return [`${spec.flag}=${chromeSwitch}`]
  // Outside the browser's working and output folders, so nothing the agent
  // saves through the browser can land on it, and rewritten when it differs.
  const file = guardFileFor(slug)
  writeIfChanged(file, JSON.stringify({ browser: { launchOptions: { args: [chromeSwitch] } } }))
  return [spec.flag, file]
}

let agentReadableGuardDir: string | null = null

/** A real folder (not a link) this process's user owns, with mode 0755. */
function isOwnSharedFolder(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir)
    const me = typeof process.getuid === 'function' ? process.getuid() : st.uid
    return st.isDirectory() && st.uid === me && (st.mode & 0o777) === 0o755
  } catch {
    return false
  }
}

/**
 * Where a browser's guard file goes. In the data folder normally. With agents
 * running as their own OS user the browser runs as that user, who cannot read
 * the data folder and must not be able to change the file (it is what keeps the
 * browser off the dashboard): so a folder of this server's own, made fresh with
 * a random name under the shared temporary folder, that every user can read and
 * only this server can write.
 */
function guardFileFor(slug: string): string {
  if (!isAgentUserMode()) {
    return path.join(resolveClawbooDir(), 'browser-profiles', slug, 'guard.json')
  }
  // Checked on every use, not only when made: a temp cleaner can remove the
  // folder while the server runs, and anybody, the agent user included, could
  // then make one by the same name. Anything but this server's own 0755 folder
  // is left alone and a fresh one made.
  if (agentReadableGuardDir === null || !isOwnSharedFolder(agentReadableGuardDir)) {
    const dir = fs.mkdtempSync(
      path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'clawboo-guard-'),
    )
    fs.chmodSync(dir, 0o755)
    agentReadableGuardDir = dir
  }
  return path.join(agentReadableGuardDir, `${slug.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

/** Every launch argument that keeps this browser off the dashboard and off
 *  local files, in the forms this connector takes. */
export function browserGuardArgs(
  slug: string,
  launch: {
    blockOriginsArg?: { flag: string; style: 'origins' | 'urlPatterns' }
    chromeSwitchArg?: { flag: string; style: 'joined' | 'playwrightConfig' }
  },
  port: number | null = dashboardPort,
  bindHost: string | null = dashboardBindHost,
): string[] {
  return [
    ...blockDashboardArgs(launch.blockOriginsArg, port, bindHost),
    ...localFileArgs(launch.blockOriginsArg),
    ...networkRuleArgs(slug, launch.chromeSwitchArg, port, bindHost),
  ]
}
