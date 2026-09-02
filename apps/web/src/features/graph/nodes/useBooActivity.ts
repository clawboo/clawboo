// What one Boo is doing right now, as a single line.
//
// Extracted from `BooLiveActivity` so the thought bubble and anything else that
// wants the line read the same two sources in the same order, rather than each
// re-deriving "what is this agent up to" and drifting apart.
//
// Two sources, because a Boo can be working in two different ways:
//   • CHAT runs write to the chat store (streaming text, reasoning, tool calls)
//   • BOARD runs never touch it, so `RunStatusBridge` folds the obs tool_call
//     tail into `runActivity` — the same line the Workspace tab shows.
//
// Returns null when the agent has produced nothing yet. That is NOT the same as
// "not working": a run that has been thinking for ten seconds has no line to
// show, and the caller is expected to say so rather than render an empty
// bubble. Hence `kind`, which is what lets the caller phrase it.
//
// Every selector is single-value so one agent's frame does not re-render the
// other Boos on the graph.

import { useMemo } from 'react'

import { useChatStore } from '@/stores/chat'
import { useFleetStore } from '@/stores/fleet'
import { useRunActivityStore } from '@/stores/runActivity'

import { pickLatestActivity, type PickedActivityKind } from './pickLatestActivity'

export interface BooActivity {
  /** The line to show. Never empty. */
  text: string
  kind: PickedActivityKind
  /** The run failed; the caller should say so rather than keep animating. */
  isError: boolean
}

export function useBooActivity(agentId: string): BooActivity | null {
  const sessionKey = useFleetStore(
    (s) => s.agents.find((a) => a.id === agentId)?.sessionKey ?? null,
  )
  const status = useFleetStore((s) => s.agents.find((a) => a.id === agentId)?.status ?? null)
  const streamingText = useChatStore((s) =>
    sessionKey ? (s.streamingText.get(sessionKey) ?? null) : null,
  )
  const entries = useChatStore((s) => (sessionKey ? (s.transcripts.get(sessionKey) ?? null) : null))
  const obsLine = useRunActivityStore((s) => s.byAgent.get(agentId) ?? null)

  return useMemo(() => {
    if (status === 'error') return { text: 'ran into an error', kind: 'tool', isError: true }
    const picked =
      pickLatestActivity(streamingText, entries) ??
      (obsLine ? ({ kind: 'tool', text: obsLine } as const) : null)
    if (!picked) return null
    const text = picked.text.trim()
    if (!text) return null
    return { text, kind: picked.kind, isError: false }
  }, [status, streamingText, entries, obsLine])
}
