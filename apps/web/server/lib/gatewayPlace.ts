// Where the configured OpenClaw Gateway runs, as far as a URL can say, and
// whether anything is listening there. For the idle answer's next due time: a
// Gateway on another machine fires its own cron whether or not this one sleeps,
// and a Gateway nobody is listening for fires nothing.
//
// A name this machine cannot place reads as `unplaced`, never as another machine:
// counting a Gateway's jobs that would have run anyway costs a wake, while not
// counting the jobs of a Gateway that sleeps with this machine misses them.

import net from 'node:net'
import os from 'node:os'

import { isLoopbackHost } from './resolveHost'

export type GatewayPlace = 'here' | 'elsewhere' | 'unplaced'

export interface PlacedGateway {
  place: GatewayPlace
  /** The host to reach it on: the URL's, with an any-address bind read as loopback. */
  host: string
  port: number
}

/** This machine's names, as the placement reads them. Each read may fail. */
export interface MachineNames {
  hostname(): string
  addresses(): string[]
}

const thisMachine: MachineNames = {
  hostname: () => os.hostname(),
  addresses: () =>
    Object.values(os.networkInterfaces())
      .flat()
      .map((i) => i?.address ?? '')
      .filter(Boolean),
}

/** `::ffff:127.0.0.1` → `127.0.0.1`: an IPv4 address written as IPv6, in either
 *  spelling (the URL parser turns the dotted one into `::ffff:7f00:1`). */
function unmapped(host: string): string {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (dotted) return dotted[1]!
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (!hex) return host
  const hi = parseInt(hex[1]!, 16)
  const lo = parseInt(hex[2]!, 16)
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** Where the Gateway at `url` runs, or null when there is no URL to read. Never throws. */
export function placeGateway(
  url: string | undefined,
  machine: MachineNames = thisMachine,
): PlacedGateway | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = unmapped(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''))
  const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:'
  const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80
  const anyAddress = host === '0.0.0.0' || host === '::'
  const reach = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host

  const bare = (name: string): string => name.toLowerCase().replace(/\.local$/, '')
  const hostname = safe(() => machine.hostname(), '')
  const here =
    anyAddress ||
    isLoopbackHost(host) ||
    host.endsWith('.localhost') ||
    (hostname !== '' && bare(host) === bare(hostname)) ||
    safe(() => machine.addresses(), [])
      .map((a) => unmapped(a.toLowerCase()))
      .includes(host)
  if (here) return { place: 'here', host: reach, port }
  // An address literal that is none of this machine's is another machine. A name
  // could be either (a LAN name, a tailnet name), so it stays unplaced.
  if (net.isIP(host) !== 0) return { place: 'elsewhere', host, port }
  return { place: 'unplaced', host, port }
}

/**
 * Is anything listening at host:port? `closed` only when the connection was
 * refused, which means nothing is there; a timeout or any other error is `unknown`.
 */
export function probeListening(
  host: string,
  port: number,
  timeoutMs = 1_000,
): Promise<'open' | 'closed' | 'unknown'> {
  return new Promise((resolve) => {
    let done = false
    const socket = net.connect({ host, port })
    const finish = (answer: 'open' | 'closed' | 'unknown'): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs, () => finish('unknown'))
    socket.once('connect', () => finish('open'))
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish(err.code === 'ECONNREFUSED' ? 'closed' : 'unknown'),
    )
  })
}
