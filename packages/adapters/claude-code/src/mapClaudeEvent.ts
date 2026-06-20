import type { RuntimeEvent } from '@clawboo/executor'

import type { ClaudeNativeEvent } from './types'

/** Run/session ids the mapper stamps onto every emitted RuntimeEvent base. */
export interface MapContext {
  runId: string | null
  sessionId: string | null
}

/** Recover the native session id from the frames that carry one (init/result). */
export function claudeNativeId(ev: ClaudeNativeEvent): string | undefined {
  if (ev.type === 'init') return ev.sessionId
  if (ev.type === 'result') return ev.sessionId ?? undefined
  return undefined
}

/**
 * Pure native→RuntimeEvent mapper for Claude Code. Each native event yields
 * zero or more normalized events with a monotonic `seq` (via `nextSeq`). Claude
 * Code emits a real `total_cost_usd`, so the `cost` event carries a concrete
 * `costUsd` (NOT estimated) — the opposite of the Codex adapter.
 */
export function mapClaudeEvent(
  ev: ClaudeNativeEvent,
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

    case 'result': {
      const out: RuntimeEvent[] = []
      if (ev.usage || ev.costUsd != null) {
        out.push({
          ...base(),
          kind: 'cost',
          costUsd: ev.costUsd ?? null,
          usage: ev.usage ?? { inputTokens: 0, outputTokens: 0 },
          model: ev.model ?? null,
        })
      }
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
          code: null,
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
