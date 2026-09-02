// Retrying the network failures that mean "try again", and only those.
//
// WHY THIS EXISTS. A remote connector's every step goes over the network:
// discovery, dynamic registration, the token exchange, the MCP handshake, and
// each tool call. Measured against a live provider from an ordinary laptop,
// those requests fail intermittently at the transport layer often enough that
// one attempt is not a design, and the fourth attempt is what succeeded when
// this was written. Each of those failures reached the operator as
// `TypeError: fetch failed`, which reads as broken software rather than as a
// flaky moment, and the button they pressed appeared to do nothing.
//
// ONLY TRANSPORT FAILURES. A request that ARRIVED and was refused must never be
// repeated: a 4xx will be refused identically, and a write that arrived and
// timed out on the way back could be applied twice. What is retried here is the
// case where the request demonstrably did not reach the other end, which is
// exactly what Node reports as `fetch failed` with the cause carrying a
// connection-level code.

/** Connection-level failures. Every one of these means the request did not arrive. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
])

function codesIn(err: unknown, depth = 0): string[] {
  if (depth > 4 || !(err instanceof Error)) return []
  const code = (err as { code?: unknown }).code
  const here = typeof code === 'string' ? [code] : []
  return [...here, ...codesIn((err as { cause?: unknown }).cause, depth + 1)]
}

/**
 * Whether this failure is worth another attempt.
 *
 * `fetch failed` is matched by MESSAGE as well as by code, because undici
 * reports a bare `TypeError: fetch failed` with an empty cause when the request
 * never left the machine at all, and that is the single most common shape of
 * the failures this exists for.
 */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (codesIn(err).some((c) => TRANSIENT_CODES.has(c))) return true
  return /fetch failed|socket hang up|network|ECONNRESET/i.test(err.message)
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number
  /** Base delay in ms. Doubles each attempt. */
  delayMs?: number
  /** Injected in tests so they do not sleep. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Run `fn`, retrying only failures that never reached the other end.
 *
 * Rethrows the LAST error rather than a wrapper, so the caller's own message
 * still describes what it was doing when it gave up.
 */
export async function retryTransient<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3
  const base = opts.delayMs ?? 300
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let last: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (err) {
      last = err
      // A refusal is an answer. Repeating it wastes the operator's time and
      // tells them nothing new.
      if (!isTransient(err) || i === attempts - 1) throw err
      await sleep(base * 2 ** i)
    }
  }
  throw last
}
