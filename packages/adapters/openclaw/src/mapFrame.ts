// Maps raw OpenClaw Gateway event frames into the normalized `RuntimeEvent`
// stream. Deliberately reuses the SAME pure parsers the live SPA pipeline uses
// (`parseChatPayload`, `parseAgentPayload`, `isReasoningStream`, `parseMessage`,
// `extractText`, `extractThinking`) so the adapter inherits their proven
// behavior against the real Gateway instead of re-deriving frame shapes — and
// it stays decoupled from the app's Zustand-shaped `EventIntent`.

import type { EventFrame } from '@clawboo/gateway-client'
import { isReasoningStream, parseAgentPayload, parseChatPayload } from '@clawboo/events'
import { extractText, extractThinking, parseMessage } from '@clawboo/protocol'
import type { RuntimeEvent, RuntimeEventBase } from '@clawboo/executor'

export interface MapContext {
  /** The run this frame belongs to (late-bound; may be empty before binding). */
  runId: string | null
  /** The session this frame belongs to (the OpenClaw sessionKey). */
  sessionId: string | null
}

/** True when a chat frame represents a run terminal (final / aborted / error). */
export function isTerminalFrame(frame: EventFrame): boolean {
  if (frame.event !== 'chat') return false
  const p = parseChatPayload(frame.payload)
  return p?.state === 'final' || p?.state === 'aborted' || p?.state === 'error'
}

/**
 * Translate one frame into zero or more RuntimeEvents. Stateless except for the
 * optional `accumulatedText` used to give an aborted run a non-empty summary
 * (the Gateway drops streamed text on abort).
 */
/** Bytes of a tool result worth keeping. Comfortably above the largest row the
 *  event log has ever held, far below what one `exec` can produce. */
const TOOL_PAYLOAD_MAX = 4000

/**
 * A tool result, shrunk to something an event log can hold.
 *
 * REQUIRED at this boundary rather than downstream. `appendEvent` scrubs secrets
 * but applies no length cap, and a tool result is arbitrary: a file read, a
 * directory listing, the whole of a page. The largest row the log has ever held
 * is about 3KB, and one unbounded `exec` result would dwarf every row before it
 * in a table that has no prune path.
 *
 * The cap is honest about itself. A silently shortened result reads as a tool
 * that returned little, so the suffix says what happened and how much is missing.
 */
function capToolPayload(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : value === null || value === undefined
        ? ''
        : safeStringify(value)
  if (text.length <= TOOL_PAYLOAD_MAX) return text
  const dropped = text.length - TOOL_PAYLOAD_MAX
  return `${text.slice(0, TOOL_PAYLOAD_MAX)}\n... [${dropped} more characters not recorded]`
}

/** Never throws on a cyclic or exotic payload: this runs inside an event handler. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function mapFrameToRuntimeEvents(
  frame: EventFrame,
  ctx: MapContext,
  nextSeq: () => number,
  now: () => number = () => Date.now(),
  accumulatedText = '',
): RuntimeEvent[] {
  const base = (): RuntimeEventBase => ({
    runId: ctx.runId ?? '',
    sessionId: ctx.sessionId,
    ts: now(),
    seq: nextSeq(),
  })
  const events: RuntimeEvent[] = []

  if (frame.event === 'chat') {
    const p = parseChatPayload(frame.payload)
    if (!p) return events
    const message = p.message ?? null

    // Incremental text only on the streaming state — the final message restates
    // the same text and would otherwise double up.
    if (p.state === 'delta' && message) {
      const text = extractText(message)
      if (text) events.push({ ...base(), kind: 'text-delta', text, channel: 'assistant' })
      const thinking = extractThinking(message)
      if (thinking)
        events.push({ ...base(), kind: 'text-delta', text: thinking, channel: 'reasoning' })
    }

    // Tool calls / results may ride on either a delta or the final message.
    if (message) {
      const parsed = parseMessage(message)
      for (const tc of parsed.toolCalls) {
        events.push({
          ...base(),
          kind: 'tool-call',
          toolCallId: tc.id ?? `${p.runId}:${tc.name}`,
          name: tc.name,
          input: tc.arguments,
          partial: false,
        })
      }
      for (const tr of parsed.toolResults) {
        events.push({
          ...base(),
          kind: 'tool-result',
          toolCallId: tr.toolCallId ?? '',
          name: tr.name,
          output: tr.output,
          isError: tr.isError ?? false,
        })
      }
    }

    if (p.state === 'final') {
      const summary = (message ? extractText(message) : null) ?? ''
      events.push({ ...base(), kind: 'done', reason: 'success', summary })
    } else if (p.state === 'aborted') {
      const summary = (message ? extractText(message) : null) || accumulatedText || ''
      events.push({ ...base(), kind: 'done', reason: 'aborted', summary })
    } else if (p.state === 'error') {
      const msg = p.errorMessage ?? 'error'
      events.push({
        ...base(),
        kind: 'error',
        code: p.stopReason ?? null,
        message: msg,
        fatal: true,
      })
      events.push({ ...base(), kind: 'done', reason: 'error', summary: msg })
    }
    return events
  }

  if (frame.event === 'agent') {
    const p = parseAgentPayload(frame.payload)
    if (!p) return events
    const stream = p.stream ?? ''
    const data = p.data ?? {}

    if (stream === 'lifecycle') {
      const phase = typeof data['phase'] === 'string' ? data['phase'] : ''
      if (phase === 'start') events.push({ ...base(), kind: 'status', phase: 'running' })
      else if (phase === 'end') events.push({ ...base(), kind: 'status', phase: 'turn-complete' })
      else if (phase === 'error') {
        // Surface the ACTUAL error detail from the lifecycle payload instead of a
        // generic "agent error" — without this the obs log + chat show nothing
        // actionable. OpenClaw puts the reason in one of a few fields; take the first.
        const pick = (k: string): string | null =>
          typeof data[k] === 'string' && (data[k] as string).trim() ? (data[k] as string) : null
        const detail =
          pick('error') ?? pick('message') ?? pick('reason') ?? pick('detail') ?? pick('text')
        const codeVal = data['code']
        events.push({
          ...base(),
          kind: 'error',
          code: typeof codeVal === 'string' ? codeVal : null,
          message: detail ?? 'agent error',
          fatal: true,
        })
      }
      return events
    }

    // ── Tool calls ────────────────────────────────────────────────────────
    //
    // The stream that makes an OpenClaw agent's work visible at all. Every other
    // branch here carries what the agent SAID; this one carries what it DID, and
    // without it a Boo that spent ten minutes running commands showed up in
    // clawboo as a paragraph of prose and nothing else.
    //
    // These frames only arrive because the connection declared the `tool-events`
    // capability (see the AgentSource registry). They are addressed to the
    // connection that STARTED the run, which is what keeps them from arriving
    // twice: the Gateway's other tool sink explicitly excludes the recipients of
    // this one.
    if (stream === 'tool') {
      const phase = typeof data['phase'] === 'string' ? data['phase'] : ''
      const toolCallId = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
      const name = typeof data['name'] === 'string' ? data['name'] : ''
      // Both required. A frame without them cannot be paired into a call and a
      // result, and a half-identified tool call in the feed is worse than none.
      if (!toolCallId || !name) return events

      if (phase === 'start') {
        events.push({
          ...base(),
          kind: 'tool-call',
          toolCallId,
          name,
          input: data['args'] ?? null,
          partial: false,
        })
      } else if (phase === 'result') {
        events.push({
          ...base(),
          kind: 'tool-result',
          toolCallId,
          name,
          output: capToolPayload(data['result']),
          isError: data['isError'] === true,
        })
      }
      // `update` carries partialResult and is dropped on purpose. It is the bulk
      // of the volume, and the activity feed logs only settled calls anyway, so
      // keeping it would grow the event log to show something nothing reads.
      return events
    }

    const dataText =
      typeof data['text'] === 'string'
        ? data['text']
        : typeof data['delta'] === 'string'
          ? data['delta']
          : ''
    if (dataText) {
      const channel = isReasoningStream(stream) ? 'reasoning' : 'assistant'
      events.push({ ...base(), kind: 'text-delta', text: dataText, channel })
    }
    return events
  }

  return events
}
