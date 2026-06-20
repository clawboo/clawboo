import type { RuntimeEvent } from '@clawboo/executor'

import type { HermesNativeEvent } from './types'

export interface MapContext {
  runId: string | null
  sessionId: string | null
}

/** Recover the native session id from the frames that carry one. */
export function hermesNativeId(ev: HermesNativeEvent): string | undefined {
  if (ev.type === 'session') return ev.sessionId
  if (ev.type === 'result') return ev.sessionId ?? undefined
  return undefined
}

/**
 * Pure native→RuntimeEvent mapper for Hermes. Coarse (block-level) text deltas
 * since Hermes is non-streaming; cost is `estimated` (token usage only, no
 * reliable headless USD).
 */
export function mapHermesEvent(
  ev: HermesNativeEvent,
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
    case 'session':
      return [
        { ...base(), kind: 'status', phase: 'init', ...(ev.model ? { model: ev.model } : {}) },
      ]

    case 'message': {
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
      if (ev.usage) {
        out.push({
          ...base(),
          kind: 'cost',
          costUsd: null,
          estimated: true,
          usage: ev.usage,
          model: ev.model ?? null,
        })
      }
      if (ev.aborted) {
        out.push({ ...base(), kind: 'done', reason: 'aborted', summary: ev.summary || accumulated })
      } else if (ev.ok) {
        out.push({
          ...base(),
          kind: 'done',
          reason: 'success',
          summary: ev.summary,
          ...(ev.usage ? { usage: ev.usage } : {}),
          costUsd: null,
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
      return []
  }
}
