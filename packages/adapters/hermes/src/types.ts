import type { StartOpts, SteerOptions, Usage } from '@clawboo/executor'

/**
 * A native lifecycle event from a Hermes run. The driver reads these off the
 * Hermes gateway's run event stream as they arrive (text, tool calls and
 * results) and its final event (usage). Hermes reports tokens but no USD, so cost
 * is `estimated` from tokens (like Codex). `sessionId` is the resume handle
 * (Hermes persists it in the profile's `state.db`).
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
  /** The run is still going. A long tool call or an open approval prints
   *  nothing, so this periodic beat keeps idle watchdogs from reading the run as
   *  a dead one. */
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
 * The structural slice of a Hermes run the adapter drives: the injected seam.
 * The real driver runs it through the supervised Hermes gateway in the agent's
 * own profile; tests pass an in-memory double. One driver per run.
 */
export interface HermesDriver {
  start(): Promise<void>
  onEvent(handler: (ev: HermesNativeEvent) => void): () => void
  abort(): Promise<void>
  setModel(model: string): Promise<void>
  writeContext(key: string, value: string): Promise<void>
  /** Get `text` to the running turn. False when the run cannot take it now (it
   *  ended, or is not running); throws when the call failed. Optional so a test
   *  double without it simply cannot be steered. */
  steer?(text: string, opts?: SteerOptions): Promise<boolean>
  /** How THIS run takes a steer. Absent means live. */
  steering?(): 'live' | 'interrupt-resume'
}

export type HermesDriverFactory = (opts: StartOpts) => HermesDriver
