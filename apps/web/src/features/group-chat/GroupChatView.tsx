// GroupChatView — unified header + a below-header area that swaps between three
// states: the onboarding gate (full-window, NO graph — the user is still being
// introduced to the team, so the team showcase stays out of the way), a brief
// neutral placeholder while onboarding state hydrates, and the settled "team
// space" split (group chat on the left, Ghost Graph card on the right). In the
// team space the header moves inside the chat pane (see TeamSpaceSplit).
//
// The transition is owned by `TeamSpaceSplit`: when the user finishes the gate,
// it swaps to the split and the graph "opens" down from the top of its card
// while the chat settles beside it, but ONLY when the user actually came THROUGH
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
import { apiFetch } from '@clawboo/control-client'
import { TeamOnboardingGate } from './TeamOnboardingGate'
import { GroupChatViewHeader } from './GroupChatViewHeader'
import { useTeamOnboarding } from './useTeamOnboarding'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useBooZeroStore } from '@/stores/booZero'
import { useRoom, useRoomStore } from '@/stores/rooms'
import { LazyBoundary } from '@/features/shared/LazyBoundary'
import { createRetryableLazy } from '@/lib/lazyRetry'
import { buildTeamSessionKey } from '@/lib/sessionUtils'

// The settled team space (TeamSpaceSplit) owns the team-scoped Ghost Graph,
// which pulls in React Flow + elk.bundled.js. Lazy-load it so those libraries
// stay off the entry chunk until a user actually opens a team space. Retryable,
// so a failed chunk shows a card with a "Try again" inside the team space rather
// than throwing past the view's own boundary.
const teamSpaceSplitSource = createRetryableLazy(() =>
  import('./TeamSpaceSplit').then((m) => ({ default: m.TeamSpaceSplit })),
)

export function GroupChatView({
  teamId,
  roomId = null,
}: {
  teamId: string
  /** One of the team's chat rooms; null = the team's own group chat. */
  roomId?: string | null
}) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === teamId) ?? null)
  const room = useRoom(teamId, roomId)
  const agents = useFleetStore((s) => s.agents)
  const teamAgents = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])
  // The agents this conversation is between: the room's members, or the whole
  // team for its own group chat. Onboarding is the team's, so the gate below
  // still introduces the whole team (a room of an onboarded team skips it).
  const chatAgents = useMemo(() => {
    if (!roomId) return teamAgents
    const members = new Set(room?.memberIds ?? [])
    return teamAgents.filter((a) => members.has(a.id))
  }, [teamAgents, roomId, room])

  // A room's members come from the room list; read it if this view opened first.
  useEffect(() => {
    if (roomId && !useRoomStore.getState().loadedTeams.has(teamId))
      void useRoomStore.getState().load(teamId)
  }, [teamId, roomId])
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const booZeroAgent = useMemo(
    () => (booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null),
    [agents, booZeroAgentId],
  )

  const { agentsIntroduced, userIntroduced, isLoading, markAgentsIntroduced, markUserIntroduced } =
    useTeamOnboarding(teamId)

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
    for (const agent of chatAgents) {
      const teamSk = buildTeamSessionKey(agent.id, teamId, roomId)
      const existing = useChatStore.getState().transcripts.get(teamSk)
      if (existing && existing.length > 0) continue
      apiFetch(`/api/chat-history?sessionKey=${encodeURIComponent(teamSk)}`)
        .then((r) => r.json())
        .then(({ entries: historical }: { entries?: TranscriptEntry[] }) => {
          if (historical && historical.length > 0) {
            useChatStore.getState().appendTranscript(teamSk, historical)
          }
        })
        .catch(() => {})
    }
  }, [chatAgents, teamId, roomId])

  // The settled team space renders the header inside its chat pane.
  const settled = !isLoading && onboardingComplete

  return (
    <div className="flex h-full flex-col">
      {!settled && <GroupChatViewHeader team={team} room={room} />}
      <div className="flex-1 min-h-0">
        {isLoading ? (
          // Hydrating onboarding state — a full-window neutral beat with NO
          // graph, so a still-onboarding team never flashes the split first.
          <div className="h-full bg-background" />
        ) : !onboardingComplete ? (
          // Onboarding — the gate fills the whole window (no graph on top).
          <div className="h-full">
            <TeamOnboardingGate
              teamId={teamId}
              team={team}
              teamAgents={teamAgents}
              booZeroAgent={booZeroAgent}
              agentsIntroduced={agentsIntroduced}
              userIntroduced={userIntroduced}
              onMarkAgentsIntroduced={markAgentsIntroduced}
              onMarkUserIntroduced={markUserIntroduced}
            />
          </div>
        ) : (
          // Settled team space — when the user came through the gate this
          // session, the split plays its "open" animation (the graph reveals
          // down from the top of its card). The split is
          // lazy-loaded (it owns the team-scoped Ghost Graph + React Flow/ELK),
          // so we hold a neutral full-window beat (header kept) while its chunk
          // resolves, matching the hydrating placeholder above, so there's no flash.
          <LazyBoundary
            source={teamSpaceSplitSource}
            label="the team space"
            suspenseFallback={
              <div className="flex h-full flex-col">
                <GroupChatViewHeader team={team} room={room} showCounts={false} />
                <div className="min-h-0 flex-1 bg-background" />
              </div>
            }
            render={(TeamSpaceSplit) => (
              <div className="h-full">
                <TeamSpaceSplit
                  teamId={teamId}
                  roomId={roomId}
                  team={team}
                  animateOpen={sawGateRef.current}
                />
              </div>
            )}
            logContext={{ teamId }}
          />
        )}
      </div>
    </div>
  )
}
