// Directive parsing for the fault-injecting mock runtime.
//
// Pure, so the failure grammar can be tested without spawning anything. A
// directive is a leading `!word` on its own line; everything that is not a
// recognised directive is ordinary text the run echoes back.
//
// Why a text grammar rather than a config object: the point of this runtime is to
// be driven through the REAL paths, and the only thing that reaches an adapter
// from a board task or a chat turn is the message. Encoding the fault in the
// message means a fault can be injected from anywhere a task can be created,
// including the live server, with no test-only side channel.
//
// Nothing here spawns a process or touches a shell. The mock never executes
// anything: a "tool call" is a synthesized event on the normalized stream, and
// the tool NAME is an opaque label the host only ever logs.

/** One parsed instruction for the mock run. */
export type Directive =
  /** Emit deltas then `done:success`. The default when nothing else is given. */
  | { kind: 'ok'; text: string }
  /** Emit nothing for `ms`. Exercises the drain idle guard and the stale sweep. */
  | { kind: 'silent'; ms: number }
  /** A `tool-call` with no matching `tool-result`: the open-tool-call allowance. */
  | { kind: 'toolcall'; name: string }
  /** A fatal `error` event: failure reflection and the mailbox alert. */
  | { kind: 'error'; message: string }
  /** Never terminate until aborted: the abort path and mutex release. */
  | { kind: 'abort' }
  /** `n` identical tool-call/result pairs: the circuit breaker's no-progress rule. */
  | { kind: 'loop'; times: number }
  /** Delay before `start()` resolves: the mutex acquire timeout, pre-first-event beat. */
  | { kind: 'slowstart'; ms: number }
  /** Throw from `events()`: drain error handling and the `stopBeat` finally. */
  | { kind: 'crash' }

const MAX_LOOP = 50
const MAX_DELAY_MS = 10 * 60_000
/** Opaque label for a synthesized tool call. Represents a long-running build. */
const DEFAULT_TOOL_LABEL = 'build'

const clampMs = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(Math.floor(n), MAX_DELAY_MS)
}

/**
 * Parse the directives out of a run's text.
 *
 * Unrecognised lines are ignored rather than rejected: the message a real board
 * task carries is prose with a directive somewhere in it, not a pure instruction
 * list. When nothing is recognised the run behaves normally and echoes the text,
 * so an ordinary task against this runtime still succeeds.
 */
export function parseDirectives(input: string): Directive[] {
  const out: Directive[] = []
  for (const line of input.split('\n')) {
    const m = /^\s*!(\w+)\s*(.*)$/.exec(line)
    if (!m) continue
    const word = m[1] ?? ''
    const arg = (m[2] ?? '').trim()
    switch (word.toLowerCase()) {
      case 'ok':
        out.push({ kind: 'ok', text: arg || 'ok' })
        break
      case 'silent':
        out.push({ kind: 'silent', ms: clampMs(arg, 1_000) })
        break
      case 'toolcall':
        out.push({ kind: 'toolcall', name: arg || DEFAULT_TOOL_LABEL })
        break
      case 'error':
        out.push({ kind: 'error', message: arg || 'injected failure' })
        break
      case 'abort':
        out.push({ kind: 'abort' })
        break
      case 'loop': {
        const n = Number(arg)
        out.push({
          kind: 'loop',
          times: Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LOOP) : 3,
        })
        break
      }
      case 'slowstart':
        out.push({ kind: 'slowstart', ms: clampMs(arg, 500) })
        break
      case 'crash':
        out.push({ kind: 'crash' })
        break
      default:
        break // not a directive we know; leave it as prose
    }
  }
  return out
}

/** The `slowstart` delay, if any. Read before `start()` resolves. */
export function startDelayMs(directives: Directive[]): number {
  for (const d of directives) if (d.kind === 'slowstart') return d.ms
  return 0
}
