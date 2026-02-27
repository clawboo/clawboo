import type { EventFrame } from '@clawboo/gateway-client'

import { classifyEvent } from './bridge'
import { derivePolicy } from './policy/index'
import type { ClassifiedEvent, EventHandlerHandle } from './types'

// ── Types ──────────────────────────────────────────────────────────────────

export type {
  AgentEventPayload,
  AgentStatusPatch,
  ChatEventPayload,
  ChatState,
  ClassifiedEvent,
  EventHandlerDeps,
  EventHandlerHandle,
  EventIntent,
  EventKind,
  EventPlane,
  LifecyclePhase,
  LifecycleTransition,
} from './types'

// ── Bridge ─────────────────────────────────────────────────────────────────

export {
  classifyEvent,
  dedupeRunLines,
  extractText,
  extractThinking,
  extractToolLines,
  isReasoningStream,
  mergeRuntimeStream,
  parseAgentPayload,
  parseChatPayload,
  resolveLifecyclePatch,
} from './bridge'

// ── Policy ─────────────────────────────────────────────────────────────────

export { derivePolicy } from './policy/index'
export { decideAgentEvent } from './policy/agent'
export { decideTrustEvent } from './policy/trust'
export { decideWorkAgentEvent, decideWorkChatEvent } from './policy/work'

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
