import type { TranscriptEntry } from '@clawboo/protocol'
import type { AgentState } from '@/stores/fleet'

const DELEGATE_REGEX = /<delegate\s+to="@?([^"]+)">/i
const FRESH_IDLE_WINDOW_MS = 60_000 // "Just done" lasts 60 s after status flips to idle
const VERB_NAME_CLAMP = 16 // max @TargetName chars in "Delegating to @X"

export interface ActivityVerbInput {
  agent: AgentState
  /** Live `transcripts` map from useChatStore. */
  transcripts: Map<string, TranscriptEntry[]> | null
  /** Live `streamingText` map from useChatStore. */
  streamingTexts: Map<string, string> | null
  /** Override clock for tests; defaults to Date.now(). */
  now?: number
}

/**
 * Return a short verb describing what the agent is doing **right now**, in
 * place of the generic "Running" / "Idle" label. Pure function — no Zustand
 * subscriptions, no React. Phase 18.
 *
 * Mappings (in priority order):
 *  - `error`                              → "Error"
 *  - `sleeping`                           → "Sleeping"
 *  - `running` + streamingText contains
 *    a `<delegate to="@X">` tag           → "Delegating to @X"
 *  - `running` + streamingText non-empty  → "Streaming reply"
 *  - `running` + most-recent assistant
 *    entry has a `<delegate>` block       → "Delegating to @X"
 *  - `running` + no committed delegation  → "Thinking…"
 *  - `idle` + last seen < 60 s ago        → "Just done"
 *  - `idle` (default)                     → "Idle"
 */
export function getActivityVerb({
  agent,
  transcripts,
  streamingTexts,
  now = Date.now(),
}: ActivityVerbInput): string {
  if (agent.status === 'error') return 'Error'
  if (agent.status === 'sleeping') return 'Sleeping'

  if (agent.status === 'running') {
    const sk = agent.sessionKey
    const stream = sk ? (streamingTexts?.get(sk) ?? null) : null

    if (stream && stream.length > 0) {
      const target = matchDelegateTarget(stream)
      if (target) return `Delegating to @${target}`
      return 'Streaming reply'
    }

    if (sk && transcripts) {
      const entries = transcripts.get(sk) ?? []
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]
        if (!e) continue
        if (e.kind !== 'assistant' || e.role !== 'assistant') continue
        const target = matchDelegateTarget(e.text)
        if (target) return `Delegating to @${target}`
        // Only inspect the most-recent assistant entry — older delegations
        // belong to past turns and don't describe the current activity.
        break
      }
    }

    return 'Thinking…'
  }

  const lastSeen = agent.lastSeenAt
  if (lastSeen != null && now - lastSeen >= 0 && now - lastSeen < FRESH_IDLE_WINDOW_MS) {
    return 'Just done'
  }
  return 'Idle'
}

function matchDelegateTarget(text: string): string | null {
  const m = text.match(DELEGATE_REGEX)
  if (!m || !m[1]) return null
  const name = m[1].trim()
  if (!name) return null
  return name.length > VERB_NAME_CLAMP ? `${name.slice(0, VERB_NAME_CLAMP - 1)}…` : name
}
