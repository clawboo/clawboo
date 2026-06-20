import type { RuntimeEvent } from '@clawboo/executor'

// Mirror client-observed runtime events into the durable obs event log.
//
// The OpenClaw team-chat path observes its agents' lifecycle events IN THE
// BROWSER (via the adapter), so the server never sees the per-tool detail. This
// batcher POSTs those events to `/api/obs/ingest` so the activity terminal is
// uniform across runtimes (server-run runtimes already emit them via the
// executor runner). Best-effort + fire-and-forget — a failed POST never affects
// orchestration. Board lifecycle (task/claim/status/comment) is emitted
// server-side by the board REST handlers, so it is NOT mirrored here.

export interface ObsMirrorEvent {
  /** Restricted server-side to tool_call | tool_result | error. */
  kind: 'tool_call' | 'tool_result' | 'error'
  teamId?: string | null
  taskId?: string | null
  agentId?: string | null
  runtime?: string | null
  ts?: number
  data?: Record<string, unknown>
}

export interface ObsMirror {
  /** Queue one event; flushes on a short debounce or when the buffer fills. */
  push(event: ObsMirrorEvent): void
  /** Flush the buffer now (also called internally). */
  flush(): void
  /** Drop the buffer + timer (team switch / teardown). */
  reset(): void
}

const DEFAULT_FLUSH_MS = 1000
const FLUSH_AT = 50 // flush eagerly once this many are buffered
const MAX_POST = 200 // one POST carries at most this many

export function createObsMirror(opts?: { flushMs?: number; endpoint?: string }): ObsMirror {
  const flushMs = opts?.flushMs ?? DEFAULT_FLUSH_MS
  const endpoint = opts?.endpoint ?? '/api/obs/ingest'
  let queue: ObsMirrorEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (queue.length === 0) return
    const batch = queue.splice(0, MAX_POST)
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    }).catch(() => {
      /* best-effort: a dropped mirror never affects orchestration */
    })
    if (queue.length > 0) schedule()
  }

  const schedule = (): void => {
    if (!timer) timer = setTimeout(flush, flushMs)
  }

  return {
    push(event) {
      queue.push(event)
      if (queue.length >= FLUSH_AT) flush()
      else schedule()
    },
    flush,
    reset() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      queue = []
    },
  }
}

/** Map a normalized RuntimeEvent to its mirror shape, or null if not mirrored. */
export function toMirrorEvent(
  event: RuntimeEvent,
  ctx: { teamId: string; agentId: string | null; taskId: string | null; nowMs: number },
): ObsMirrorEvent | null {
  const base = {
    teamId: ctx.teamId,
    agentId: ctx.agentId,
    taskId: ctx.taskId,
    runtime: 'openclaw',
    ts: ctx.nowMs,
  }
  if (event.kind === 'tool-call' && !event.partial) {
    return {
      ...base,
      kind: 'tool_call',
      data: { toolCallId: event.toolCallId, name: event.name, input: event.input },
    }
  }
  if (event.kind === 'tool-result') {
    return {
      ...base,
      kind: 'tool_result',
      data: {
        toolCallId: event.toolCallId,
        name: event.name,
        output: event.output,
        isError: event.isError,
      },
    }
  }
  if (event.kind === 'error') {
    return {
      ...base,
      kind: 'error',
      data: { code: event.code, message: event.message, fatal: event.fatal },
    }
  }
  return null
}
