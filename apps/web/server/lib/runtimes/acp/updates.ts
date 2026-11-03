// What an ACP agent's `session/update` notifications and `session/prompt` result
// mean to clawboo, read off the protocol's own fields (`sessionUpdate`,
// `toolCallId`, `status`, `usage`), so any ACP agent maps the same way. Agent-
// specific readings (how a title names its tool) stay with that agent's driver.

import type { Usage } from '@clawboo/executor'

import type { AcpSessionUpdate } from './connection'

/** A session update, as the parts clawboo acts on. */
export type AcpUpdate =
  | { kind: 'text'; text: string; channel: 'assistant' | 'reasoning' }
  | { kind: 'tool-start'; id: string; title: string; toolKind?: string; input: unknown }
  | { kind: 'tool-end'; id: string; output: string; failed: boolean }

/** How a prompt turn ended (`stopReason` of the `session/prompt` result). */
export type AcpStopReason =
  'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | (string & {})

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** The text of a content block (`{ type: 'text', text }`), else ''. */
function blockText(block: unknown): string {
  const b = asRecord(block)
  return b?.['type'] === 'text' ? (asStr(b['text']) ?? '') : ''
}

/** A tool call's content list as plain text: text blocks verbatim, a diff as the
 *  path it changed. */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const c = asRecord(item)
    if (!c) continue
    if (c['type'] === 'content') {
      const text = blockText(c['content'])
      if (text) parts.push(text)
    } else if (c['type'] === 'diff') {
      const path = asStr(c['path'])
      if (path) parts.push(`edited ${path}`)
    }
  }
  return parts.join('\n')
}

const stringify = (v: unknown): string => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** One `session/update` → zero or more updates clawboo acts on. Plans, mode and
 *  command lists, context-window gauges and echoes of the user's own message
 *  carry nothing a run needs, so they map to nothing. */
export function normalizeAcpUpdate(update: AcpSessionUpdate): AcpUpdate[] {
  switch (asStr(update['sessionUpdate'])) {
    case 'agent_message_chunk': {
      const text = blockText(update['content'])
      return text ? [{ kind: 'text', text, channel: 'assistant' }] : []
    }
    case 'agent_thought_chunk': {
      const text = blockText(update['content'])
      return text ? [{ kind: 'text', text, channel: 'reasoning' }] : []
    }
    case 'tool_call': {
      const id = asStr(update['toolCallId'])
      if (!id) return []
      const out: AcpUpdate[] = [
        {
          kind: 'tool-start',
          id,
          title: asStr(update['title']) ?? 'tool',
          ...(asStr(update['kind']) ? { toolKind: asStr(update['kind']) } : {}),
          input: update['rawInput'] ?? toolContentText(update['content']),
        },
      ]
      // A call can arrive already finished (a replayed or instant tool).
      const status = asStr(update['status'])
      if (status === 'completed' || status === 'failed') out.push(toolEnd(id, update, status))
      return out
    }
    case 'tool_call_update': {
      const id = asStr(update['toolCallId'])
      const status = asStr(update['status'])
      // Only a terminal status ends a call; progress updates carry no result.
      if (!id || (status !== 'completed' && status !== 'failed')) return []
      return [toolEnd(id, update, status)]
    }
    default:
      return []
  }
}

function toolEnd(
  id: string,
  update: AcpSessionUpdate,
  status: 'completed' | 'failed',
): Extract<AcpUpdate, { kind: 'tool-end' }> {
  const raw = update['rawOutput']
  const output = raw != null ? stringify(raw) : toolContentText(update['content'])
  return { kind: 'tool-end', id, output, failed: status === 'failed' }
}

/** The token usage a `session/prompt` result reports, or undefined when it
 *  reports none. Agents that report it per session (cumulative) and per turn
 *  both fit, since clawboo runs one turn per process. */
export function acpPromptUsage(result: unknown): Usage | undefined {
  const usage = asRecord(asRecord(result)?.['usage'])
  if (!usage) return undefined
  const inputTokens = asNum(usage['inputTokens'])
  const outputTokens = asNum(usage['outputTokens'])
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const cached = asNum(usage['cachedReadTokens'])
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  }
}

/** The `stopReason` of a `session/prompt` result. */
export function acpStopReason(result: unknown): AcpStopReason | undefined {
  return asStr(asRecord(result)?.['stopReason'])
}
