import { parseAgentPayload, parseChatPayload } from '../bridge'
import type { ClassifiedEvent, EventIntent } from '../types'
import { decideAgentEvent } from './agent'
import { decideTrustEvent } from './trust'
import { decideWorkAgentEvent, decideWorkChatEvent } from './work'

// ── derivePolicy — main router ─────────────────────────────────────────────

export function derivePolicy(event: ClassifiedEvent): EventIntent[] {
  switch (event.kind) {
    case 'summary-refresh':
      return decideAgentEvent(event)

    case 'runtime-chat': {
      const payload = parseChatPayload(event.payload)
      if (!payload) return [{ kind: 'ignore', reason: 'malformed chat payload' }]
      return decideWorkChatEvent(event, payload)
    }

    case 'runtime-agent': {
      const payload = parseAgentPayload(event.payload)
      if (!payload) return [{ kind: 'ignore', reason: 'malformed agent payload' }]
      return decideWorkAgentEvent(event, payload)
    }

    case 'approval':
      return decideTrustEvent(event)

    case 'unknown':
    default:
      return [{ kind: 'ignore', reason: 'unknown event kind' }]
  }
}
