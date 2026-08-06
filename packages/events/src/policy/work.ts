import { extractText, extractThinking, extractToolLines, isReasoningStream } from '../bridge'
import type {
  AgentEventPayload,
  AgentStatusPatch,
  ChatCost,
  ChatEventPayload,
  ClassifiedEvent,
  EventIntent,
} from '../types'

// ── deriveChatCost ─────────────────────────────────────────────────────────

/** Chars-per-token used when the Gateway sends no usage block. */
const CHARS_PER_TOKEN = 4

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asCount = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0)

/**
 * Token spend for one committed turn, derived purely from the frame.
 *
 * Real usage wins when the Gateway reports it. Otherwise the OUTPUT side is
 * estimated here (the response text is right there in the frame) and the INPUT
 * side is left `null` for the host to estimate from the agent's last user
 * message — that needs a transcript read, which would break Policy's purity.
 *
 * Returns `null` when there is no message to price at all.
 */
export function deriveChatCost(
  payload: ChatEventPayload,
  responseText: string | null,
): ChatCost | null {
  const message = asRecord(payload.message)
  if (!message) return null

  const model =
    payload.model ?? (typeof message['model'] === 'string' ? message['model'] : 'unknown')

  const usage = asRecord(message['usage']) ?? asRecord(asRecord(message['metadata'])?.['usage'])
  if (usage) {
    return {
      model,
      inputTokens: asCount(usage['input_tokens']),
      outputTokens: asCount(usage['output_tokens']),
    }
  }

  return {
    model,
    inputTokens: null,
    outputTokens: responseText ? Math.ceil(responseText.length / CHARS_PER_TOKEN) : 0,
  }
}

// ── decideWorkChatEvent ────────────────────────────────────────────────────

export function decideWorkChatEvent(
  event: ClassifiedEvent,
  payload: ChatEventPayload,
): EventIntent[] {
  const agentId = event.agentId
  if (!agentId) return [{ kind: 'ignore', reason: 'chat event missing agentId' }]

  const { state, message, errorMessage, runId } = payload

  if (state === 'delta') {
    const streamText = extractText(message) ?? undefined
    const thinkingTrace = extractThinking(message) ?? undefined
    const patch: AgentStatusPatch = {
      ...(streamText !== undefined ? { streamText } : {}),
      ...(thinkingTrace !== undefined ? { thinkingTrace } : {}),
      runId,
      lastActivityAt: event.timestamp,
    }
    return [{ kind: 'queueLivePatch', plane: 'work', agentId, sessionKey: event.sessionKey, patch }]
  }

  if (state === 'final') {
    const toolLines = extractToolLines(message)
    const streamText = extractText(message) ?? null
    const thinkingTrace = extractThinking(message) ?? null
    const patch: AgentStatusPatch = {
      status: 'idle',
      runId: null,
      runStartedAt: null,
      streamText: null,
      thinkingTrace: null,
      lastActivityAt: event.timestamp,
    }
    const outputLines: string[] = []
    if (streamText) outputLines.push(streamText)
    outputLines.push(...toolLines)

    const intents: EventIntent[] = [
      { kind: 'clearPendingLivePatch', plane: 'work', agentId },
      {
        kind: 'commitChat',
        plane: 'work',
        agentId,
        sessionKey: event.sessionKey,
        runId,
        patch,
        outputLines,
        cost: deriveChatCost(payload, streamText),
      },
    ]
    // Request history refresh if no thinking trace was present in the final message
    if (!thinkingTrace) {
      intents.push({
        kind: 'requestHistoryRefresh',
        plane: 'agent',
        agentId,
        reason: 'chat-final-no-trace',
      })
    }
    return intents
  }

  if (state === 'aborted') {
    const patch: AgentStatusPatch = {
      status: 'idle',
      runId: null,
      runStartedAt: null,
      streamText: null,
      thinkingTrace: null,
    }
    return [
      { kind: 'clearPendingLivePatch', plane: 'work', agentId },
      {
        kind: 'commitChat',
        plane: 'work',
        agentId,
        sessionKey: event.sessionKey,
        runId,
        patch,
        outputLines: [],
        // An aborted turn is not billed — parity with the raw-frame subscriber
        // this replaced, which only ever fired on `state === 'final'`.
        cost: null,
      },
    ]
  }

  if (state === 'error') {
    const patch: AgentStatusPatch = {
      status: 'error',
      runId: null,
      runStartedAt: null,
      streamText: errorMessage ?? null,
      thinkingTrace: null,
    }
    return [
      { kind: 'clearPendingLivePatch', plane: 'work', agentId },
      {
        kind: 'commitChat',
        plane: 'work',
        agentId,
        sessionKey: event.sessionKey,
        runId,
        patch,
        outputLines: [],
        cost: null,
      },
    ]
  }

  return [{ kind: 'ignore', reason: `unknown chat state: ${state}` }]
}

// ── decideWorkAgentEvent ───────────────────────────────────────────────────

export function decideWorkAgentEvent(
  event: ClassifiedEvent,
  payload: AgentEventPayload,
): EventIntent[] {
  const agentId = event.agentId
  if (!agentId) return [{ kind: 'ignore', reason: 'agent event missing agentId' }]

  const { stream, data, runId } = payload

  // Lifecycle stream
  if (stream === 'lifecycle') {
    const phase = typeof data?.['phase'] === 'string' ? data['phase'] : ''

    if (phase === 'start') {
      const patch: AgentStatusPatch = {
        status: 'running',
        runId,
        runStartedAt: event.timestamp,
        streamText: null,
        thinkingTrace: null,
      }
      return [{ kind: 'updateAgentStatus', plane: 'agent', agentId, runId, patch }]
    }

    if (phase === 'end') {
      const patch: AgentStatusPatch = {
        status: 'idle',
        runId: null,
        runStartedAt: null,
        streamText: null,
        thinkingTrace: null,
        lastActivityAt: event.timestamp,
      }
      return [{ kind: 'updateAgentStatus', plane: 'agent', agentId, runId, patch }]
    }

    if (phase === 'error') {
      const patch: AgentStatusPatch = {
        status: 'error',
        runId: null,
        runStartedAt: null,
        streamText: null,
        thinkingTrace: null,
        lastActivityAt: event.timestamp,
      }
      return [{ kind: 'updateAgentStatus', plane: 'agent', agentId, runId, patch }]
    }

    return [{ kind: 'ignore', reason: `unknown lifecycle phase: ${phase}` }]
  }

  // Reasoning stream
  if (stream && isReasoningStream(stream)) {
    const thinkingTrace = typeof data?.['text'] === 'string' ? data['text'] : ''
    if (!thinkingTrace) return [{ kind: 'ignore', reason: 'reasoning stream with no text' }]
    const patch: AgentStatusPatch = { thinkingTrace, runId, lastActivityAt: event.timestamp }
    return [{ kind: 'queueLivePatch', plane: 'work', agentId, sessionKey: event.sessionKey, patch }]
  }

  // Assistant stream
  if (stream === 'assistant') {
    const streamText = typeof data?.['text'] === 'string' ? data['text'] : ''
    if (!streamText) return [{ kind: 'ignore', reason: 'assistant stream with no text' }]
    const patch: AgentStatusPatch = { streamText, runId, lastActivityAt: event.timestamp }
    return [{ kind: 'queueLivePatch', plane: 'work', agentId, sessionKey: event.sessionKey, patch }]
  }

  // Tool stream — output lines are handled by the handler via appendOutputLines
  return [
    { kind: 'ignore', reason: `tool/unknown stream (handled by handler): ${stream ?? 'none'}` },
  ]
}
