import type { StartOpts, Usage } from '@clawboo/executor'

/**
 * A native lifecycle event from a headless Hermes run. Hermes has no live token
 * stream (the adapter's `capabilities().streaming` is false): the real driver
 * derives these structured events from Hermes's run output + its `state.db`
 * (sessions / messages), rather than scraping rendered text. Hermes records
 * token usage but the headless USD is unreliable, so cost is `estimated` (like
 * Codex). `sessionId` is the resume handle (Hermes persists it in `state.db`).
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
  | {
      type: 'result'
      ok: boolean
      summary: string
      usage?: Usage
      model?: string
      sessionId?: string
      aborted?: boolean
      errorMessage?: string
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
}

export type HermesDriverFactory = (opts: StartOpts) => HermesDriver
