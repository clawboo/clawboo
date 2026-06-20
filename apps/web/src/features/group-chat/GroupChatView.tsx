// GroupChatView — unified header + a below-header area that swaps between three
// states: the onboarding gate (full-window, NO graph — the user is still being
// introduced to the team, so the team showcase stays out of the way), a brief
// neutral placeholder while onboarding state hydrates, and the settled "team
// space" split (Ghost Graph on top, group chat on bottom).
//
// The transition is owned by `TeamSpaceSplit`: when the user finishes the gate,
// it swaps to the split and the graph "opens" down from the top into its slot
// while the chat settles below — but ONLY when the user actually came THROUGH
// the gate this session (`sawGateRef`). Returning users (already onboarded when
// the view mounts) never set the ref, so they land on the split instantly.
//
// These three states are a PLAIN conditional, NOT an `AnimatePresence` — this
// view already lives inside `ContentArea`'s `<AnimatePresence mode="wait">`, and
// a nested `mode="wait"` deadlocks (the exiting child's `onExitComplete` never
// fires, stranding the panel blank). The chat fills the window the instant the
// split mounts, so the gate→split swap has no blank frame to cover anyway.
//
// Team orchestration (delegation routing + context relay) is ALWAYS on — it's
// the whole point of a team chat. There's no UI toggle; the orchestration hook
// in `GroupChatPanel` is gated only by the connection status (so it stays quiet
// when the Gateway is down).

import { useEffect, useMemo, useRef } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { TeamOnboardingGate } from './TeamOnboardingGate'
import { GroupChatViewHeader } from './GroupChatViewHeader'
import { TeamSpaceSplit } from './TeamSpaceSplit'
import { useTeamOnboarding } from './useTeamOnboarding'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useBooZeroStore } from '@/stores/booZero'
import { buildTeamSessionKey } from '@/lib/sessionUtils'

export function GroupChatView({ teamId }: { teamId: string }) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === teamId) ?? null)
  const agents = useFleetStore((s) => s.agents)
  const client = useConnectionStore((s) => s.client)
  const teamAgents = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const booZeroAgent = useMemo(
    () => (booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null),
    [agents, booZeroAgentId],
  )

  const {
    agentsIntroduced,
    userIntroduced,
    userIntroText,
    isLoading,
    markAgentsIntroduced,
    markUserIntroduced,
  } = useTeamOnboarding(teamId)

  const onboardingComplete = agentsIntroduced && userIntroduced

  // Track whether the user passed THROUGH the onboarding gate this session. Only
  // then does the split play its "open" animation; returning users (already
  // onboarded when the view mounts) land on the settled split with no animation.
  const sawGateRef = useRef(false)
  useEffect(() => {
    if (!isLoading && !onboardingComplete) sawGateRef.current = true
  }, [isLoading, onboardingComplete])

  // Pre-load chat history for all team agents BEFORE the split renders so that
  // returning users can see their existing transcripts the moment the team space
  // settles (or skip the gate entirely if onboarding is complete on the server).
  useEffect(() => {
    for (const agent of teamAgents) {
      const teamSk = buildTeamSessionKey(agent.id, teamId)
      const existing = useChatStore.getState().transcripts.get(teamSk)
      if (existing && existing.length > 0) continue
      fetch(`/api/chat-history?sessionKey=${encodeURIComponent(teamSk)}`)
        .then((r) => r.json())
        .then(({ entries: historical }: { entries?: TranscriptEntry[] }) => {
          if (historical && historical.length > 0) {
            useChatStore.getState().appendTranscript(teamSk, historical)
          }
        })
        .catch(() => {})
    }
  }, [teamAgents, teamId])

  return (
    <div className="flex h-full flex-col">
      <GroupChatViewHeader team={team} />
      <div className="flex-1 min-h-0">
        {isLoading ? (
          // Hydrating onboarding state — a full-window neutral beat with NO
          // graph, so a still-onboarding team never flashes the split first.
          <div className="h-full bg-bg" />
        ) : !onboardingComplete ? (
          // Onboarding — the gate fills the whole window (no graph on top).
          <div className="h-full">
            <TeamOnboardingGate
              teamId={teamId}
              team={team}
              teamAgents={teamAgents}
              booZeroAgent={booZeroAgent}
              client={client}
              agentsIntroduced={agentsIntroduced}
              userIntroduced={userIntroduced}
              onMarkAgentsIntroduced={markAgentsIntroduced}
              onMarkUserIntroduced={markUserIntroduced}
            />
          </div>
        ) : (
          // Settled team space — when the user came through the gate this
          // session, the split plays its "open" animation (graph grows down
          // from the top into its slot; chat settles below).
          <div className="h-full">
            <TeamSpaceSplit
              teamId={teamId}
              userIntroText={userIntroText}
              animateOpen={sawGateRef.current}
            />
          </div>
        )}
      </div>
    </div>
  )
}
