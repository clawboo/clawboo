/**
 * @clawboo/process-lookup
 *
 * Resolve a TCP port to the PID listening on it, cross-platform.
 *
 * Two callers need this and neither can import the other: the `clawboo` CLI's
 * `stop` / `restart`, and the dashboard server's managed-Gateway control
 * (`stopGateway`). It lived as a copy in each until the copies started to
 * matter — both feed a `process.kill`, so a wrong answer force-kills an
 * innocent process, and a fix applied to one copy but not the other is a bug
 * that only shows up on one surface.
 *
 * Three details are load-bearing rather than incidental:
 *
 *   1. `-sTCP:LISTEN` on POSIX. Plain `lsof -i :PORT` also matches CONNECTED
 *      sockets, so a browser tab open on the dashboard is in that output and
 *      taking the first line could hand back the browser's PID.
 *   2. A raised `maxBuffer` for `netstat -ano`. Node's 1 MB default throws
 *      ENOBUFS on a host with thousands of connections, which the catch below
 *      would silently turn into "no process found".
 *   3. The locale-independent listener fallback in `parseNetstatPid`.
 *
 * The parsers are pure and exported so all three behaviors are unit-testable
 * without spawning anything.
 */
import { execFileSync } from 'node:child_process'

/** Strict PID parse: digits only, positive. Rejects lsof `-F` output (`p1234`). */
function toPid(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const pid = Number(trimmed)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Parse `lsof -t` output (one PID per line) into deduped PIDs in output order.
 *
 * A dual-stack Node listener (`0.0.0.0` + `::`) reports the same PID on two
 * lines, so the dedupe is what makes the returned list a list of *processes*
 * rather than of sockets. `findListenerPid` only ever takes the first entry;
 * the full list is exported for readability and for the tests.
 */
export function parseLsofPids(stdout: string): number[] {
  const pids: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const pid = toPid(line)
    if (pid !== null && !pids.includes(pid)) pids.push(pid)
  }
  return pids
}

const LISTENER_FOREIGN_ADDRESSES = new Set(['0.0.0.0:0', '[::]:0'])

/**
 * Parse `netstat -ano` output for the PID listening on `port`.
 *
 * TCP row layout is `Proto  Local  Foreign  State  PID`; the PID is always the
 * last column, which holds even when a localized state string contains a space
 * (French `À L'ÉCOUTE` splits into two columns and shifts everything after it).
 *
 * An explicit `LISTENING` row always wins. Failing that we fall back to a row
 * whose local address is our port AND whose foreign address is the all-zero
 * placeholder — the structural signature of a listening socket, which no locale
 * translates.
 */
export function parseNetstatPid(stdout: string, port: number): number | null {
  const suffix = `:${port}`
  let localized: number | null = null

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const cols = trimmed.split(/\s+/)
    // Proto + Local + Foreign + State + PID. UDP rows have no State and are
    // shorter; the header rows ("Proto", "Active Connections") fail the TCP test.
    if (cols.length < 5) continue
    if ((cols[0] ?? '').toUpperCase() !== 'TCP') continue
    // Read the LOCAL address specifically — a foreign address ending in our port
    // is a connection TO someone else's service, not our listener.
    if (!(cols[1] ?? '').endsWith(suffix)) continue
    const pid = toPid(cols[cols.length - 1] ?? '')
    if (pid === null) continue
    if (/\bLISTENING\b/i.test(trimmed)) return pid
    if (localized === null && LISTENER_FOREIGN_ADDRESSES.has(cols[2] ?? '')) localized = pid
  }

  return localized
}

/**
 * The PID listening on `port`, or null when it cannot be determined — the tool
 * is missing (`lsof` is absent from Alpine and some hardened images), nothing is
 * listening, or the socket belongs to another user and is invisible to us.
 * Never throws; the caller reports "could not identify" rather than guessing.
 */
export function findListenerPid(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('netstat', ['-ano'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
        // See note 2 in the file header.
        maxBuffer: 16 * 1024 * 1024,
      })
      return parseNetstatPid(output, port)
    }
    // -n / -P skip DNS and /etc/services lookups (a stalled resolver would block
    // this synchronous call); -sTCP:LISTEN is note 1 in the file header; stderr
    // is discarded because lsof warns loudly about other users' processes.
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseLsofPids(output)[0] ?? null
  } catch {
    // lsof exits 1 when nothing matches, and both tools throw ENOENT when absent.
    // Both are "no answer", not errors.
    return null
  }
}
