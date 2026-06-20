import type { StartOpts, Usage } from '@clawboo/executor'

/**
 * A native lifecycle event from a running `codex exec` session, normalized off
 * its `--json` event stream. Two Codex realities are encoded here vs. Claude
 * Code: (1) Codex carries a `thread` (its resume handle), and (2) Codex reports
 * NO USD cost — a `result` carries token `usage` only, and the mapper marks the
 * derived cost `estimated`. Whether the driver emits incremental `text` events
 * or one block per turn is its choice; the adapter maps either to text-deltas.
 */
export type CodexNativeEvent =
  | { type: 'thread'; threadId: string; model?: string }
  | { type: 'text'; text: string; channel?: 'assistant' | 'reasoning' }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: string; isError?: boolean }
  | {
      type: 'result'
      ok: boolean
      summary: string
      /** Codex reports token usage but NO USD — cost is derived + `estimated`. */
      usage?: Usage
      model?: string
      threadId?: string
      aborted?: boolean
      errorMessage?: string
    }

/**
 * The structural slice of a running Codex session the adapter drives — the
 * injected seam. The real driver spawns `codex exec --json` in an isolated
 * `CODEX_HOME`; tests pass an in-memory double. One driver per run.
 */
export interface CodexDriver {
  start(): Promise<void>
  onEvent(handler: (ev: CodexNativeEvent) => void): () => void
  abort(): Promise<void>
  setModel(model: string): Promise<void>
  writeContext(key: string, value: string): Promise<void>
}

export type CodexDriverFactory = (opts: StartOpts) => CodexDriver
