import type { StartOpts, Usage } from '@clawboo/executor'

/**
 * A native lifecycle event from a running Claude Code session, lightly
 * normalized off the Claude Agent SDK's `query()` stream (the SDK already emits
 * structured message objects — `system`/`init`, assistant content blocks,
 * `result` — so this is a faithful re-shape, NOT terminal scraping). The real
 * server-side driver translates SDK messages into this union; the pure
 * `mapClaudeEvent` turns this union into the normalized `RuntimeEvent` stream.
 */
export type ClaudeNativeEvent =
  | { type: 'init'; sessionId: string; model?: string }
  | { type: 'text'; text: string; channel?: 'assistant' | 'reasoning' }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: string; isError?: boolean }
  | {
      type: 'result'
      /** true = the run finished cleanly; false = error/abort. */
      ok: boolean
      summary: string
      /** Claude Code emits a REAL USD cost — pass it straight through. */
      costUsd?: number | null
      usage?: Usage
      model?: string
      sessionId?: string
      aborted?: boolean
      /** The run stopped because it hit its turn ceiling (SDK
       *  `result.subtype === 'error_max_turns'`). A clean "ran out of room"
       *  terminal — distinct from a failure — so the host can rotate the session
       *  and continue rather than fail the task. */
      maxTurns?: boolean
      errorMessage?: string
    }

/**
 * The structural slice of a running Claude Code session the adapter drives —
 * the injected seam (analogous to OpenClaw's `OpenClawGatewayClient`). The real
 * driver wraps the Claude Agent SDK; tests pass an in-memory double. One driver
 * instance is created per run (a subprocess/SDK query is one-shot).
 */
export interface ClaudeCodeDriver {
  /** Begin the run. The real driver starts the SDK query + buffers any native
   *  events emitted before `onEvent` subscribes. */
  start(): Promise<void>
  /** Subscribe to the run's native event stream; returns an unsubscribe fn. */
  onEvent(handler: (ev: ClaudeNativeEvent) => void): () => void
  /** Cancel the in-flight run. */
  abort(): Promise<void>
  /** Apply a model change (best-effort; one-shot runtimes may record-only). */
  setModel(model: string): Promise<void>
  /** Persist a context file/value into the run's workspace. */
  writeContext(key: string, value: string): Promise<void>
}

/** Fresh driver per run — the adapter calls this in `start()`. */
export type ClaudeCodeDriverFactory = (opts: StartOpts) => ClaudeCodeDriver
