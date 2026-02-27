import { extractText, extractThinking, extractToolLines, isReasoningStream } from '../bridge'
import type {
  AgentEventPayload,
  AgentStatusPatch,
  ChatEventPayload,
  ClassifiedEvent,
  EventIntent,
} from '../types'

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
    return [{ kind: 'queueLivePatch', plane: 'work', agentId, patch }]
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
      { kind: 'commitChat', plane: 'work', agentId, patch, outputLines },
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
      { kind: 'commitChat', plane: 'work', agentId, patch, outputLines: [] },
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
      { kind: 'commitChat', plane: 'work', agentId, patch, outputLines: [] },
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
      return [{ kind: 'updateAgentStatus', plane: 'agent', agentId, patch }]
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
      return [{ kind: 'updateAgentStatus', plane: 'agent', agentId, patch }]
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
      return [{ kind: 'updateAgentStatus', plane: 'agent', agentId, patch }]
    }

    return [{ kind: 'ignore', reason: `unknown lifecycle phase: ${phase}` }]
  }

  // Reasoning stream
  if (stream && isReasoningStream(stream)) {
    const thinkingTrace = typeof data?.['text'] === 'string' ? data['text'] : ''
    if (!thinkingTrace) return [{ kind: 'ignore', reason: 'reasoning stream with no text' }]
    const patch: AgentStatusPatch = { thinkingTrace, runId, lastActivityAt: event.timestamp }
    return [{ kind: 'queueLivePatch', plane: 'work', agentId, patch }]
  }

  // Assistant stream
  if (stream === 'assistant') {
    const streamText = typeof data?.['text'] === 'string' ? data['text'] : ''
    if (!streamText) return [{ kind: 'ignore', reason: 'assistant stream with no text' }]
    const patch: AgentStatusPatch = { streamText, runId, lastActivityAt: event.timestamp }
    return [{ kind: 'queueLivePatch', plane: 'work', agentId, patch }]
  }

  // Tool stream — output lines are handled by the handler via appendOutputLines
  return [
    { kind: 'ignore', reason: `tool/unknown stream (handled by handler): ${stream ?? 'none'}` },
  ]
}
