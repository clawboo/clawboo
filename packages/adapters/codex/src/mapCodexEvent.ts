import type { RuntimeEvent } from '@clawboo/executor'

import type { CodexNativeEvent } from './types'

export interface MapContext {
  runId: string | null
  sessionId: string | null
}

/** Recover the native thread id from the frames that carry one. */
export function codexNativeId(ev: CodexNativeEvent): string | undefined {
  if (ev.type === 'thread') return ev.threadId
  if (ev.type === 'result') return ev.threadId ?? undefined
  return undefined
}

/**
 * Pure native→RuntimeEvent mapper for Codex. Mirrors the Claude Code mapper
 * EXCEPT for the cost asymmetry: Codex reports no USD, so a `result` with token
 * usage yields `cost{ costUsd: null, estimated: true }` — never a concrete USD.
 */
export function mapCodexEvent(
  ev: CodexNativeEvent,
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
    case 'thread':
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
      if (ev.usage) {
        // Codex gives no USD — surface usage with an explicitly estimated, null cost.
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
