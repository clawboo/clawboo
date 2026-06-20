// ─────────────────────────────────────────────────────────────────────────────
// RuntimeEvent — the normalized lifecycle-event union every runtime adapter
// emits. One shape across heterogeneous runtimes (the OpenClaw Gateway today;
// other coding-agent runtimes later) so the orchestrator, board, and UI consume
// a single stream and stay decoupled from per-runtime quirks.
//
// Two runtime asymmetries are encoded in the types, not papered over:
//   • some runtimes report no USD cost  → `cost.costUsd: number | null` + `estimated?`
//   • some runtimes emit no incremental text → a single synthetic `text-delta`
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeEventKind =
  | 'text-delta'
  | 'tool-call'
  | 'tool-result'
  | 'status'
  | 'cost'
  | 'done'
  | 'error'

/** Token usage for a run (USD is carried separately on the `cost` event). */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}

/**
 * Common envelope on every event. `sessionId` is the runtime's session handle
 * (an OpenClaw sessionKey, a CLI thread id, etc.). `seq` is a strictly
 * increasing per-stream tiebreaker so consumers can order events that share a
 * millisecond timestamp.
 */
export interface RuntimeEventBase {
  runId: string
  sessionId: string | null
  ts: number
  seq: number
}

export type RuntimeEvent =
  // Incremental assistant text. `channel` separates user-visible output from
  // reasoning/thinking traces. Runtimes without native deltas emit one synthetic
  // delta carrying the whole message.
  | (RuntimeEventBase & { kind: 'text-delta'; text: string; channel?: 'assistant' | 'reasoning' })
  // A tool/function invocation. `partial` is true while the input JSON is still
  // streaming (false once the full call is known).
  | (RuntimeEventBase & {
      kind: 'tool-call'
      toolCallId: string
      name: string
      input: unknown
      partial: boolean
    })
  // The outcome of a tool call.
  | (RuntimeEventBase & {
      kind: 'tool-result'
      toolCallId: string
      name: string
      output: string
      isError: boolean
    })
  // A non-text lifecycle signal (run started, thinking, running, turn complete).
  | (RuntimeEventBase & {
      kind: 'status'
      phase: 'init' | 'thinking' | 'running' | 'turn-complete'
      model?: string
      detail?: string
    })
  // Token usage (+ USD when the runtime reports it). `costUsd` is null when the
  // runtime cannot supply USD; `estimated` flags a derived (non-authoritative) value.
  | (RuntimeEventBase & {
      kind: 'cost'
      costUsd: number | null
      usage: Usage
      model: string | null
      estimated?: boolean
    })
  // Terminal summary for a single run/turn.
  | (RuntimeEventBase & {
      kind: 'done'
      reason: 'success' | 'max_turns' | 'aborted' | 'error'
      summary: string
      usage?: Usage
      costUsd?: number | null
    })
  // A recoverable or fatal failure.
  | (RuntimeEventBase & { kind: 'error'; code: string | null; message: string; fatal: boolean })

/** Compile-time exhaustiveness guard for switch statements over RuntimeEvent. */
export function assertExhaustive(x: never): never {
  throw new Error(`Unhandled RuntimeEvent variant: ${JSON.stringify(x)}`)
}
