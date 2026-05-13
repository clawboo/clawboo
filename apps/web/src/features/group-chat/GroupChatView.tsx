// GroupChatView — unified header + 2-row resizable layout. The header above
// the split owns team identity (icon + name + agent count) — so the team
// name never renders twice (it used to appear in both `GhostGraphPanel`'s
// toolbar and `GroupChatPanel`'s header). Below the header:
// `GhostGraphPanel` on top (in `embedded` mode → its toolbar drops the
// team-name prefix and just says "Ghost Graph"), `GroupChatPanel` on
// bottom (in `embedded` mode → its own header is suppressed). Gates the
// `GroupChatPanel` behind the team onboarding flow ("Know Your Team"
// button → agent intros → user self-intro → normal chat).
//
// Team orchestration (delegation routing + context relay) is ALWAYS on —
// it's the whole point of a team chat. There's no UI toggle; the
// `useTeamOrchestration` hook in `GroupChatPanel` is gated only by the
// connection status (so it stays quiet when the Gateway is down).

import { useEffect, useMemo } from 'react'
import { Group, Panel } from 'react-resizable-panels'
import type { TranscriptEntry } from '@clawboo/protocol'
import { ResizeHandle } from '@/features/shared/ResizeHandle'
import { GroupChatPanel } from './GroupChatPanel'
import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { TeamOnboardingGate } from './TeamOnboardingGate'
import { GroupChatViewHeader } from './GroupChatViewHeader'
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

  // Pre-load chat history for all team agents BEFORE the gate renders so that
  // returning users can see their existing transcripts when entering Phase C
  // (or skip the gate entirely if onboarding is complete on the server).
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

  const header = <GroupChatViewHeader team={team} />

  // While onboarding state is hydrating, render the layout but hide the
  // chat-side content to avoid a flash of the gate before redirecting to
  // normal chat (or vice versa).
  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex-1 min-h-0">
          <Group orientation="vertical" id="group-chat-v" data-testid="group-chat-view">
            <Panel defaultSize={45} minSize={20}>
              <GhostGraphPanel embedded />
            </Panel>
            <ResizeHandle direction="vertical" />
            <Panel defaultSize={55} minSize={20}>
              <div className="flex h-full items-center justify-center bg-bg" />
            </Panel>
          </Group>
        </div>
      </div>
    )
  }

  if (!onboardingComplete) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex-1 min-h-0">
          <Group orientation="vertical" id="group-chat-v" data-testid="group-chat-view">
            <Panel defaultSize={45} minSize={20}>
              <GhostGraphPanel embedded />
            </Panel>
            <ResizeHandle direction="vertical" />
            <Panel defaultSize={55} minSize={20}>
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
            </Panel>
          </Group>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="flex-1 min-h-0">
        <Group orientation="vertical" id="group-chat-v" data-testid="group-chat-view">
          <Panel defaultSize={45} minSize={20}>
            <GhostGraphPanel embedded />
          </Panel>
          <ResizeHandle direction="vertical" />
          <Panel defaultSize={55} minSize={20}>
            <GroupChatPanel teamId={teamId} userIntroText={userIntroText} embedded />
          </Panel>
        </Group>
      </div>
    </div>
  )
}
