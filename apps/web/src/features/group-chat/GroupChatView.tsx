// GroupChatView — 2-row resizable layout: GhostGraphPanel on top, GroupChatPanel
// on bottom. Stacked vertically (full width) so wide team graphs spread out
// comfortably while the chat area below gets full-width message rendering.
// Gates the GroupChatPanel behind the team onboarding flow ("Know Your Team"
// button → agent introductions → user self-introduction → normal chat).

import { useEffect, useMemo } from 'react'
import { Group, Panel } from 'react-resizable-panels'
import type { TranscriptEntry } from '@clawboo/protocol'
import { ResizeHandle } from '@/features/shared/ResizeHandle'
import { GroupChatPanel } from './GroupChatPanel'
import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { TeamOnboardingGate } from './TeamOnboardingGate'
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

  // While onboarding state is hydrating, render the layout but hide the
  // chat-side content to avoid a flash of the gate before redirecting to
  // normal chat (or vice versa).
  if (isLoading) {
    return (
      <Group orientation="vertical" id="group-chat-v" data-testid="group-chat-view">
        <Panel defaultSize={45} minSize={20}>
          <GhostGraphPanel />
        </Panel>
        <ResizeHandle direction="vertical" />
        <Panel defaultSize={55} minSize={20}>
          <div className="flex h-full items-center justify-center bg-bg" />
        </Panel>
      </Group>
    )
  }

  if (!onboardingComplete) {
    return (
      <Group orientation="vertical" id="group-chat-v" data-testid="group-chat-view">
        <Panel defaultSize={45} minSize={20}>
          <GhostGraphPanel />
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
    )
  }

  return (
    <Group orientation="vertical" id="group-chat-v" data-testid="group-chat-view">
      <Panel defaultSize={45} minSize={20}>
        <GhostGraphPanel />
      </Panel>
      <ResizeHandle direction="vertical" />
      <Panel defaultSize={55} minSize={20}>
        <GroupChatPanel teamId={teamId} userIntroText={userIntroText} />
      </Panel>
    </Group>
  )
}
