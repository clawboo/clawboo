import type { EventFrame } from '@clawboo/gateway-client'
import { extractText, extractThinking, extractToolLines } from '@clawboo/protocol'

import type { AgentEventPayload, ChatEventPayload, ClassifiedEvent } from './types'

// ── Session key → agent ID ─────────────────────────────────────────────────

const SESSION_KEY_RE = /^agent:([^:]+):/

function extractAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  const match = sessionKey.match(SESSION_KEY_RE)
  return match ? match[1] : undefined
}

// ── classifyEvent ──────────────────────────────────────────────────────────

export function classifyEvent(frame: EventFrame): ClassifiedEvent {
  const now = Date.now()
  const base = { raw: frame, payload: frame.payload, timestamp: now }

  switch (frame.event) {
    case 'presence':
    case 'heartbeat':
      return { ...base, kind: 'summary-refresh' }

    case 'chat': {
      const payload = frame.payload as Record<string, unknown> | null
      const sessionKey =
        typeof payload?.['sessionKey'] === 'string' ? payload['sessionKey'] : undefined
      const agentId = extractAgentIdFromSessionKey(sessionKey)
      return { ...base, kind: 'runtime-chat', agentId, sessionKey }
    }

    case 'agent': {
      const payload = frame.payload as Record<string, unknown> | null
      const sessionKey =
        typeof payload?.['sessionKey'] === 'string' ? payload['sessionKey'] : undefined
      const agentId =
        typeof payload?.['agentId'] === 'string'
          ? payload['agentId']
          : extractAgentIdFromSessionKey(sessionKey)
      return { ...base, kind: 'runtime-agent', agentId, sessionKey }
    }

    case 'exec.approval.pending':
    case 'exec.approval.requested':
    case 'exec.approval.resolved': {
      const payload = frame.payload as Record<string, unknown> | null
      // agentId may be at top level OR nested inside payload.request
      const topAgentId = typeof payload?.['agentId'] === 'string' ? payload['agentId'] : undefined
      const request = payload?.['request']
      const nestedAgentId =
        request && typeof request === 'object' && !Array.isArray(request)
          ? typeof (request as Record<string, unknown>)['agentId'] === 'string'
            ? ((request as Record<string, unknown>)['agentId'] as string)
            : undefined
          : undefined
      const agentId = topAgentId ?? nestedAgentId
      return { ...base, kind: 'approval', agentId }
    }

    default:
      return { ...base, kind: 'unknown' }
  }
}

// ── parseChatPayload ───────────────────────────────────────────────────────

export function parseChatPayload(payload: unknown): ChatEventPayload | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const runId = typeof p['runId'] === 'string' ? p['runId'] : ''
  const sessionKey = typeof p['sessionKey'] === 'string' ? p['sessionKey'] : ''
  const state = typeof p['state'] === 'string' ? p['state'] : ''

  if (!runId || !sessionKey) return null
  if (state !== 'delta' && state !== 'final' && state !== 'aborted' && state !== 'error')
    return null

  return {
    runId,
    sessionKey,
    state: state as ChatEventPayload['state'],
    seq: typeof p['seq'] === 'number' ? p['seq'] : undefined,
    stopReason: typeof p['stopReason'] === 'string' ? p['stopReason'] : undefined,
    message: p['message'],
    errorMessage: typeof p['errorMessage'] === 'string' ? p['errorMessage'] : undefined,
    model: typeof p['model'] === 'string' ? p['model'] : undefined,
  }
}

// ── parseAgentPayload ──────────────────────────────────────────────────────

export function parseAgentPayload(payload: unknown): AgentEventPayload | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const runId = typeof p['runId'] === 'string' ? p['runId'] : ''
  if (!runId) return null

  return {
    runId,
    seq: typeof p['seq'] === 'number' ? p['seq'] : undefined,
    stream: typeof p['stream'] === 'string' ? p['stream'] : undefined,
    data:
      p['data'] && typeof p['data'] === 'object'
        ? (p['data'] as Record<string, unknown>)
        : undefined,
    sessionKey: typeof p['sessionKey'] === 'string' ? p['sessionKey'] : undefined,
  }
}

// ── isReasoningStream ──────────────────────────────────────────────────────

const REASONING_TERMS = ['reason', 'think', 'analysis', 'trace']
const NON_REASONING_TERMS = ['assistant', 'tool', 'lifecycle']

export function isReasoningStream(stream: string): boolean {
  const lower = stream.toLowerCase()
  if (NON_REASONING_TERMS.some((term) => lower.includes(term))) return false
  return REASONING_TERMS.some((term) => lower.includes(term))
}

// Re-export protocol helpers for consumers
export { extractText, extractThinking, extractToolLines }
