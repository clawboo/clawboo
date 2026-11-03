import type { StartOpts, SteerOptions, Usage } from '@clawboo/executor'

/**
 * A native lifecycle event from a headless Hermes run. Over ACP the driver reads
 * these off Hermes's session updates as they stream (text, reasoning, tool calls
 * and results) and its prompt result (usage); on the quiet one-shot path it has
 * only the output printed at exit. Hermes's headless USD is unreliable, so cost is
 * `estimated` from tokens (like Codex). `sessionId` is the resume handle (Hermes
 * persists it in `state.db`).
 *
 * Board boundary: Hermes ships its OWN kanban — clawboo does NOT sync it. Hermes
 * is driven as a single-task WORKER on clawboo's one board of record (it reaches
 * the team's coordination surface by attaching clawboo's Tasks/Memory/Tools MCP).
 */
export type HermesNativeEvent =
  | { type: 'session'; sessionId: string; model?: string }
  | { type: 'message'; text: string; channel?: 'assistant' | 'reasoning' }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: string; isError?: boolean }
  /** The process is still running. A quiet-mode run prints nothing until it
   *  exits, so this periodic beat is what keeps idle watchdogs from reading a
   *  long run as a dead one. */
  | { type: 'status'; phase: 'running' }
  | {
      type: 'result'
      ok: boolean
      summary: string
      usage?: Usage
      model?: string
      sessionId?: string
      aborted?: boolean
      errorMessage?: string
      /** The provider's typed cause, read from the error body Hermes printed
       *  (`invalid_api_key`, `authentication_error`, `insufficient_quota`, ...). */
      errorCode?: string
    }

/**
 * The structural slice of a headless Hermes run the adapter drives — the
 * injected seam. The real driver spawns the `hermes` CLI in an isolated
 * profile/`HERMES_HOME`; tests pass an in-memory double. One driver per run.
 */
export interface HermesDriver {
  start(): Promise<void>
  onEvent(handler: (ev: HermesNativeEvent) => void): () => void
  abort(): Promise<void>
  setModel(model: string): Promise<void>
  writeContext(key: string, value: string): Promise<void>
  /** Stop the running process and resume the same session with `text` as the
   *  next input, inside this one run. False once the run has ended; throws when
   *  the resume could not be started. Optional so a test double without it
   *  simply cannot be steered. */
  steer?(text: string, opts?: SteerOptions): Promise<boolean>
}

export type HermesDriverFactory = (opts: StartOpts) => HermesDriver

/** How the host drives Hermes: `acp` over its Agent Client Protocol mode (streamed
 *  events, a steer read mid-turn), or `quiet`, the one-shot `hermes chat -Q`. */
export type HermesTransport = 'acp' | 'quiet'

export interface HermesAdapterOptions {
  /** The transport runs use now, read on every `capabilities()` call: a Hermes
   *  found without ACP falls back to `quiet`. Absent means `quiet`. */
  transport?: () => HermesTransport
}
