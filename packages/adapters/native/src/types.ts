import type { StartOpts, Usage } from '@clawboo/executor'

/**
 * A native lifecycle event from the in-process conversational harness. Unlike
 * the wrapped one-shot runtimes (whose drivers re-shape a CLI/SDK stream), the
 * native harness EMITS this union directly from its own turn loop — provider
 * SDK stream events map straight onto it, no scraping anywhere. The pure
 * `mapNativeEvent` turns this union into the normalized `RuntimeEvent` stream.
 */
export type NativeEvent =
  | { type: 'init'; sessionId: string; model?: string }
  | { type: 'text'; text: string; channel?: 'assistant' | 'reasoning' }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: string; isError?: boolean }
  | {
      /** A NON-TERMINAL, typed error within a run (the run continues) — e.g. a
       *  broker policy denial surfaced as `code: 'policy_denied'`. The terminal
       *  failure path stays the `result` frame (`ok: false`). `fatal` rides
       *  through to the RuntimeEvent so a consumer can tell them apart. */
      type: 'error'
      code: string
      message: string
      fatal: boolean
    }
  | {
      /** One per completed provider response (one model turn). `usage` is the
       *  TURN DELTA (this response's tokens, not a running total) and `costUsd`
       *  is the turn's USD — emitted per turn so the host's budget kill-switch
       *  sees live spend mid-run instead of one bill at the end. */
      type: 'turn'
      usage: Usage
      costUsd: number | null
      estimated?: boolean
      model: string
    }
  | {
      type: 'result'
      /** true = the conversation finished cleanly; false = error/abort. */
      ok: boolean
      summary: string
      sessionId?: string
      /** Context-pressure signal: `inputTokens` = the FINAL turn's input tokens
       *  (≈ live context size — what the rotation watermark reads);
       *  `outputTokens` = the run's output total. Spend already rode the
       *  per-turn `turn` events. */
      usage?: Usage
      /** Run-cumulative USD so the host's run result reports the true total.
       *  Budgets are driven by the per-turn `turn` events, never this field. */
      costUsd?: number | null
      aborted?: boolean
      /** The conversation stopped at its turn ceiling — a clean "out of room"
       *  terminal (the host rotates the session), distinct from a failure. */
      maxTurns?: boolean
      errorMessage?: string
      /** Typed error code (e.g. 'auth', 'rate_limit') so the host's error
       *  taxonomy and policy-denial classifier see structure, not prose. */
      errorCode?: string
    }

/**
 * The structural slice of a running native conversation the adapter drives —
 * the injected seam (analogous to the other adapters' driver interfaces). The
 * real driver hosts the Conversation turn loop server-side; tests pass an
 * in-memory double. One driver instance is created per run.
 */
export interface NativeDriver {
  /** Begin the run. The real driver launches the turn loop + buffers any
   *  native events emitted before `onEvent` subscribes. */
  start(): Promise<void>
  /** Subscribe to the run's native event stream; returns an unsubscribe fn. */
  onEvent(handler: (ev: NativeEvent) => void): () => void
  /** Cancel the in-flight conversation (aborts the provider stream). */
  abort(): Promise<void>
  /** Re-route subsequent turns to a different model. */
  setModel(model: string): Promise<void>
  /** Persist a context file/value into the run's workspace. */
  writeContext(key: string, value: string): Promise<void>
}

/** Fresh driver per run — the adapter calls this in `start()`. */
export type NativeDriverFactory = (opts: StartOpts) => NativeDriver
