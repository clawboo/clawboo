import type { EventFrame } from '@clawboo/gateway-client'

import { classifyEvent } from './bridge'
import { derivePolicy } from './policy/index'
import type { ClassifiedEvent, EventHandlerHandle } from './types'

// ── Types ──────────────────────────────────────────────────────────────────

export type {
  AgentEventPayload,
  AgentStatusPatch,
  ChatCost,
  ChatEventPayload,
  ChatState,
  ClassifiedEvent,
  EventHandlerDeps,
  EventHandlerHandle,
  EventIntent,
  EventKind,
  EventPlane,
} from './types'

// ── Bridge ─────────────────────────────────────────────────────────────────

export {
  classifyEvent,
  extractText,
  extractThinking,
  extractToolLines,
  isReasoningStream,
  parseAgentPayload,
  parseChatPayload,
} from './bridge'

// ── Policy ─────────────────────────────────────────────────────────────────

export { derivePolicy } from './policy/index'
export { decideAgentEvent } from './policy/agent'
export { decideTrustEvent } from './policy/trust'
export { deriveChatCost, decideWorkAgentEvent, decideWorkChatEvent } from './policy/work'

// ── Handler ────────────────────────────────────────────────────────────────

export { createEventHandler } from './handler'

// ── Patch queue ────────────────────────────────────────────────────────────

export type { Patch } from './patch-queue'
export { createPatchQueue } from './patch-queue'

// ── Convenience: full pipeline runner ─────────────────────────────────────

/**
 * Runs a raw EventFrame through the full Bridge → Policy → Handler pipeline.
 */
export function processEvent(frame: EventFrame, handler: EventHandlerHandle): void {
  const classified: ClassifiedEvent = classifyEvent(frame)
  const intents = derivePolicy(classified)
  handler.applyIntents(intents, classified)
}
