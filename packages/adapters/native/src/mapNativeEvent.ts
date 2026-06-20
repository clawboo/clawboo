import type { RuntimeEvent } from '@clawboo/executor'

import type { NativeEvent } from './types'

/** Run/session ids the mapper stamps onto every emitted RuntimeEvent base. */
export interface MapContext {
  runId: string | null
  sessionId: string | null
}

/** Recover the native session id from the frames that carry one (init/result). */
export function nativeFrameId(ev: NativeEvent): string | undefined {
  if (ev.type === 'init') return ev.sessionId
  if (ev.type === 'result') return ev.sessionId ?? undefined
  return undefined
}

/**
 * Pure native→RuntimeEvent mapper for the in-process harness. Each native event
 * yields zero or more normalized events with a monotonic `seq` (via `nextSeq`).
 * The `turn` frame maps to a `cost` event whose usage/costUsd are TURN DELTAS —
 * the host records spend per cost event, so per-turn deltas give live mid-run
 * budget enforcement. The terminal `result` carries the run-cumulative USD on
 * `done` (the host's result-reporting field, never re-billed) and the final
 * turn's input tokens as `done.usage.inputTokens` (≈ live context size — the
 * rotation watermark's signal).
 */
export function mapNativeEvent(
  ev: NativeEvent,
  ctx: MapContext,
  nextSeq: () => number,
  now: () => number = () => Date.now(),
  accumulated = '',
): RuntimeEvent[] {
  const base = () => ({
    runId: ctx.runId ?? '',
    sessionId: ctx.sessionId,
    ts: now(),
    seq: nextSeq(),
  })

  switch (ev.type) {
    case 'init':
      return [
        { ...base(), kind: 'status', phase: 'init', ...(ev.model ? { model: ev.model } : {}) },
      ]

    case 'text': {
      if (!ev.text) return []
      return [{ ...base(), kind: 'text-delta', text: ev.text, channel: ev.channel ?? 'assistant' }]
    }

    case 'tool-call':
      return [
        {
          ...base(),
          kind: 'tool-call',
          toolCallId: ev.id,
          name: ev.name,
          input: ev.input,
          partial: false,
        },
      ]

    case 'tool-result':
      return [
        {
          ...base(),
          kind: 'tool-result',
          toolCallId: ev.id,
          name: ev.name,
          output: ev.output,
          isError: ev.isError ?? false,
        },
      ]

    case 'error':
      // A non-terminal, typed error (the run continues) — e.g. a broker policy
      // denial. Maps straight to a non-fatal RuntimeEvent error the host can feed
      // to its circuit breaker.
      return [{ ...base(), kind: 'error', code: ev.code, message: ev.message, fatal: ev.fatal }]

    case 'turn':
      return [
        {
          ...base(),
          kind: 'cost',
          costUsd: ev.costUsd,
          usage: ev.usage,
          model: ev.model,
          ...(ev.estimated ? { estimated: true } : {}),
        },
      ]

    case 'result': {
      const out: RuntimeEvent[] = []
      if (ev.aborted) {
        out.push({ ...base(), kind: 'done', reason: 'aborted', summary: ev.summary || accumulated })
      } else if (ev.maxTurns) {
        // Hit the turn ceiling — a clean "out of room" terminal, NOT an error.
        // The host rotates the session (carry a handoff note) and continues.
        out.push({
          ...base(),
          kind: 'done',
          reason: 'max_turns',
          summary: ev.summary || accumulated,
          ...(ev.usage ? { usage: ev.usage } : {}),
          ...(ev.costUsd != null ? { costUsd: ev.costUsd } : {}),
        })
      } else if (ev.ok) {
        out.push({
          ...base(),
          kind: 'done',
          reason: 'success',
          summary: ev.summary,
          ...(ev.usage ? { usage: ev.usage } : {}),
          ...(ev.costUsd != null ? { costUsd: ev.costUsd } : {}),
        })
      } else {
        out.push({
          ...base(),
          kind: 'error',
          code: ev.errorCode ?? null,
          message: ev.errorMessage || 'error',
          fatal: true,
        })
        out.push({
          ...base(),
          kind: 'done',
          reason: 'error',
          summary: ev.summary || ev.errorMessage || 'error',
        })
      }
      return out
    }

    default:
      // Unknown / malformed native event — drop it rather than crash the stream.
      return []
  }
}
