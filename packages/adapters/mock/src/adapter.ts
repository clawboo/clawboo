// The fault-injecting mock RuntimeAdapter.
//
// A real adapter in the registry, not a vitest double. That distinction is the
// whole point: clawboo's coordination bugs have consistently lived in the SEAMS
// between the engine, the drain, the heartbeat and the board, and a unit fake
// swapped in at one of those seams cannot reach them. This runtime makes silence,
// a crash, an unresolved tool call and a slow start reproducible through the same
// serverDeliver and executor paths a shipped runtime uses.
//
// It executes nothing. Every "tool call" is a synthesized event on the normalized
// stream; there is no process, no shell, no filesystem write. The tool name is an
// opaque label the host only logs.
//
// GATED OFF by default. `enabledRuntimeIds()` includes it only when
// CLAWBOO_ENABLE_MOCK_RUNTIME=1, so a normal install never lists it.

import type {
  Capabilities,
  HealthResult,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

import { parseDirectives, startDelayMs, type Directive } from './directives'

export const MOCK_RUNTIME_ID = 'clawboo-mock'

/** Ceiling on a DIRECTIVE-SUPPLIED sleep. `clampMs` already bounds the parsed
 *  value; this is the bound at the point of use, applied to the tainted value
 *  itself rather than inside `sleep`. Clamping inside `sleep` also capped the
 *  `!abort` hold-open below, which is a trusted constant and is supposed to run
 *  until something aborts it. */
const MAX_DIRECTIVE_SLEEP_MS = 10 * 60_000

/** Hold until the signal aborts. NOT a sleep: expressing "wait indefinitely" as
 *  a 24-hour `setTimeout` was a timer nobody ever wanted to fire, and it is what
 *  forced `sleep` to accept an unbounded duration so the constant could pass
 *  through. With no timer here, every `setTimeout` in this file is bounded. */
const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    // Bounded AT the timer. Directive text reaches this, so the ceiling has to be
    // visible here rather than inferred across a call boundary.
    const t = setTimeout(resolve, Math.min(Math.max(0, ms || 0), MAX_DIRECTIVE_SLEEP_MS))
    ;(t as { unref?: () => void }).unref?.()
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

interface RunState {
  directives: Directive[]
  aborter: AbortController
  seq: number
}

export class MockAdapter implements RuntimeAdapter {
  readonly id = MOCK_RUNTIME_ID
  readonly participantKind = 'agent' as const

  private readonly runs = new Map<string, RunState>()

  capabilities(): Capabilities {
    return {
      streaming: true,
      mcp: false,
      // No worktree: this runtime produces no diff, so a task routed to it must
      // not be given one to verify.
      worktrees: false,
      resume: false,
      toolApproval: false,
      // Nothing reads a mid-run write here, so say so: the host must route a
      // signal to the durable mailbox instead of pretending this delivered.
      steerable: false,
      models: ['mock'],
      // The native-preservation seam is deliberately OMITTED, which resolves to
      // an EPHEMERAL home. A mock run is therefore not serialized on the
      // per-identity home mutex, and `!slowstart` is how a test opts into
      // exercising that wait rather than paying for it on every run.
    }
  }

  async health(): Promise<HealthResult> {
    return { ok: true }
  }

  async start(_task: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    const directives = parseDirectives(`${opts.message}\n${opts.context ?? ''}`)
    const delay = startDelayMs(directives)
    // Deliberately BEFORE the handle exists: a caller waiting on `start` is
    // holding whatever lock it acquired, which is exactly what `!slowstart` is
    // for. The abort path cannot help here because there is nothing to abort yet.
    if (delay > 0) await sleep(delay)
    const run: RunHandle = {
      adapterId: this.id,
      sessionKey: opts.sessionKey,
      runId: `mock-${opts.sessionKey}`,
    }
    this.runs.set(opts.sessionKey, { directives, aborter: new AbortController(), seq: 0 })
    return run
  }

  async *events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const state = this.runs.get(run.sessionKey)
    if (!state) return
    const { aborter } = state
    const base = () => ({
      runId: run.runId ?? `mock-${run.sessionKey}`,
      sessionId: run.sessionKey,
      ts: Date.now(),
      seq: ++state.seq,
    })

    try {
      for (const d of state.directives) {
        if (aborter.signal.aborted) break
        switch (d.kind) {
          case 'crash':
            // Thrown from inside the generator, so the consumer's drain sees a
            // rejection rather than a terminal — the case a `finally` must cover.
            throw new Error('mock runtime: injected crash from events()')
          case 'silent':
            await sleep(d.ms, aborter.signal)
            break
          case 'toolcall':
            // No matching tool-result, on purpose: this is what earns the longer
            // open-tool-call allowance instead of the plain idle timeout.
            yield {
              ...base(),
              kind: 'tool-call',
              toolCallId: `tc-${state.seq}`,
              name: d.name,
              input: {},
              partial: false,
            }
            break
          case 'loop':
            for (let i = 0; i < d.times; i++) {
              if (aborter.signal.aborted) break
              const id = `loop-${i}`
              yield {
                ...base(),
                kind: 'tool-call',
                toolCallId: id,
                name: 'noop',
                input: { i: 0 },
                partial: false,
              }
              yield {
                ...base(),
                kind: 'tool-result',
                toolCallId: id,
                name: 'noop',
                output: 'same',
                isError: false,
              }
            }
            break
          case 'error':
            yield { ...base(), kind: 'error', code: 'mock', message: d.message, fatal: true }
            return
          case 'abort':
            // Hold the stream open until someone aborts. The idle guard or the
            // watchdog is what should end this, never the adapter itself.
            await untilAborted(aborter.signal)
            yield { ...base(), kind: 'done', reason: 'aborted', summary: 'mock run aborted' }
            return
          case 'ok':
            yield { ...base(), kind: 'text-delta', text: d.text }
            break
        }
      }
      if (aborter.signal.aborted) {
        yield { ...base(), kind: 'done', reason: 'aborted', summary: 'mock run aborted' }
        return
      }
      const said = state.directives
        .filter((d): d is Extract<Directive, { kind: 'ok' }> => d.kind === 'ok')
        .map((d) => d.text)
        .join(' ')
      yield { ...base(), kind: 'done', reason: 'success', summary: said || 'mock run complete' }
    } finally {
      this.runs.delete(run.sessionKey)
    }
  }

  async abort(run: RunHandle): Promise<void> {
    this.runs.get(run.sessionKey)?.aborter.abort()
  }

  async setModel(): Promise<void> {
    // Nothing to switch: the mock has one model and it is a label.
  }

  async writeContext(): Promise<void> {
    // Declared `steerable: false`, so the host should never call this. A no-op
    // rather than a throw: an honest capability declaration is the guarantee,
    // and throwing here would turn a host bug into a run failure.
  }
}
