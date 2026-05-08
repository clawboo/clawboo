// GroupChatPanel — merged transcript from all team agents, sorted chronologically.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { resolveTeamLeader } from '@/lib/resolveTeamLeader'
import { agentIdFromSessionKey, buildTeamSessionKey } from '@/lib/sessionUtils'
import { sendGroupChatMessage } from './groupChatSendOperation'
import { useTeamOrchestration } from './useTeamOrchestration'
import {
  groupEntriesToBlocks,
  UserMessageCard,
  AssistantTurnCard,
  StreamingCard,
  MetaMessageCard,
  MessageComposer,
  NEAR_BOTTOM_PX,
  type MessageComposerHandle,
} from '@/features/chat/chatComponents'
import { AgentChips } from './AgentChips'
import { InlineApprovalTray } from '@/features/approvals/InlineApprovalTray'
import { Zap } from 'lucide-react'

// ─── GroupChatPanel ──────────────────────────────────────────────────────────

export function GroupChatPanel({
  teamId,
  userIntroText,
}: {
  teamId: string
  /**
   * User self-introduction captured during onboarding. Passed in from
   * `GroupChatView` (which owns the onboarding state) and forwarded to
   * `sendGroupChatMessage` so it's injected into the context preamble on
   * every message — Gateway SOUL.md persistence is unreliable, so the
   * preamble is the actual delivery mechanism for ensuring the agent knows
   * who they're talking to.
   */
  userIntroText?: string
}) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === teamId) ?? null)
  const agents = useFleetStore((s) => s.agents)
  const client = useConnectionStore((s) => s.client)
  const connectionStatus = useConnectionStore((s) => s.status)
  const transcripts = useChatStore((s) => s.transcripts)
  const streamingTextMap = useChatStore((s) => s.streamingText)

  const teamAgents = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])
  const leaderAgentId = resolveTeamLeader(teamId, team?.leaderAgentId ?? null, agents)

  // ── Orchestration toggle (persisted in localStorage) ──────────────────
  const [orchestrationEnabled, setOrchestrationEnabled] = useState<boolean>(() => {
    const stored = localStorage.getItem('clawboo:team-orchestration-enabled')
    return stored !== null ? stored === 'true' : true
  })

  // ── Team orchestration (delegation detection + context relay) ───────────
  useTeamOrchestration({
    teamId,
    teamAgents,
    leaderAgentId,
    client,
    enabled: connectionStatus === 'connected' && orchestrationEnabled,
    userIntroText,
  })

  // Agent lookup for resolving names from sessionKeys
  const agentLookup = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const a of teamAgents) {
      map.set(a.id, { id: a.id, name: a.name })
    }
    return map
  }, [teamAgents])

  // For @mention autocomplete and visual rendering
  const mentionAgentList = useMemo(
    () => teamAgents.map((a) => ({ id: a.id, name: a.name })),
    [teamAgents],
  )
  const knownAgentNames = useMemo(() => teamAgents.map((a) => a.name), [teamAgents])
  const composerRef = useRef<MessageComposerHandle>(null)

  // Team-scoped sessionKeys for isolation from 1:1 agent chat
  const teamSessionKeys = useMemo(
    () => new Map(teamAgents.map((a) => [a.id, buildTeamSessionKey(a.id, teamId)])),
    [teamAgents, teamId],
  )

  // ── Merge all team transcripts (using team-scoped sessionKeys) ────────────
  const mergedEntries = useMemo(() => {
    const all: TranscriptEntry[] = []
    for (const agent of teamAgents) {
      const teamSk = teamSessionKeys.get(agent.id)
      if (!teamSk) continue
      const entries = transcripts.get(teamSk)
      if (entries) all.push(...entries)
    }
    all.sort((a, b) => {
      const tsDiff = (a.timestampMs ?? 0) - (b.timestampMs ?? 0)
      if (tsDiff !== 0) return tsDiff
      return a.sequenceKey - b.sequenceKey
    })
    return all
  }, [teamAgents, teamSessionKeys, transcripts])

  const blocks = useMemo(() => groupEntriesToBlocks(mergedEntries), [mergedEntries])

  // ── Load persisted history for all team agents (team-scoped sessionKeys) ──
  useEffect(() => {
    for (const agent of teamAgents) {
      const teamSk = teamSessionKeys.get(agent.id)
      if (!teamSk) continue
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
  }, [teamAgents, teamSessionKeys])

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const rafRef = useRef<number | null>(null)

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [])

  const scheduleScroll = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      scrollToBottom()
    })
  }, [scrollToBottom])

  // Collect all streaming texts for team agents (using team-scoped sessionKeys)
  const activeStreams = useMemo(() => {
    const streams: { agentId: string; agentName: string; text: string }[] = []
    for (const agent of teamAgents) {
      const teamSk = teamSessionKeys.get(agent.id)
      if (!teamSk) continue
      const text = streamingTextMap.get(teamSk)
      if (text != null) {
        streams.push({ agentId: agent.id, agentName: agent.name, text })
      }
    }
    return streams
  }, [teamAgents, teamSessionKeys, streamingTextMap])

  const anyRunning = teamAgents.some((a) => a.status === 'running')

  useEffect(() => {
    if (pinnedRef.current) scheduleScroll()
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [blocks.length, activeStreams.length, scheduleScroll])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }, [])

  // ── Send handler ──────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (message: string) => {
      if (!client) return
      await sendGroupChatMessage({
        client,
        teamId,
        teamName: team?.name ?? 'Team',
        leaderAgentId,
        teamAgents,
        message,
        displayText: message, // raw message including @mention for transcript display
        userIntroText,
      })
    },
    [client, teamId, team?.name, leaderAgentId, teamAgents, userIntroText],
  )

  // ── Chip tag handler ───────────────────────────────────────────────────────
  const handleChipTag = useCallback((agentName: string) => {
    composerRef.current?.insertMention(agentName)
  }, [])

  const canSend = Boolean(
    client && connectionStatus === 'connected' && teamAgents.length > 0 && !anyRunning,
  )
  const isEmpty = blocks.length === 0 && activeStreams.length === 0

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div data-testid="group-chat-panel" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
        {team && (
          <span
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[16px]"
            style={{ background: `${team.color}22` }}
          >
            {team.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-[14px] font-semibold text-text"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {team?.name ?? 'Group Chat'}
          </h2>
          <p className="text-[10px] text-secondary/50">
            {teamAgents.length} agent{teamAgents.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          type="button"
          title="Team orchestration — auto-relay responses between agents"
          onClick={() => {
            setOrchestrationEnabled((prev) => {
              const next = !prev
              localStorage.setItem('clawboo:team-orchestration-enabled', String(next))
              return next
            })
          }}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: orchestrationEnabled ? '#34D399' : 'rgba(232,232,232,0.3)',
            transition: 'color 0.15s',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          <Zap size={14} />
        </button>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${connectionStatus === 'connected' ? 'bg-mint' : 'bg-secondary/40'}`}
        />
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4" onScroll={handleScroll}>
        {isEmpty ? (
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-[12px] text-secondary/40">
              No messages yet. Send a message to the team.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5 pb-2">
            {blocks.map((block, i) => {
              if (block.kind === 'meta') {
                return <MetaMessageCard key={block.entry.entryId} entry={block.entry} />
              }
              if (block.kind === 'user') {
                const targetId = agentIdFromSessionKey(block.entry.sessionKey)
                const targetAgent = targetId ? agentLookup.get(targetId) : null
                return (
                  <UserMessageCard
                    key={block.entry.entryId}
                    entry={block.entry}
                    targetAgentName={targetAgent?.name}
                    knownAgentNames={knownAgentNames}
                  />
                )
              }
              // assistant-turn: determine owning agent from first entry
              const firstEntry = block.assistant ?? block.thinking[0] ?? block.tools[0] ?? null
              const ownerAgentId = firstEntry ? agentIdFromSessionKey(firstEntry.sessionKey) : null
              const ownerAgent = ownerAgentId ? agentLookup.get(ownerAgentId) : null
              return (
                <AssistantTurnCard
                  key={`turn-${i}`}
                  block={block}
                  agentId={ownerAgent?.id ?? 'unknown'}
                  agentName={ownerAgent?.name ?? 'Agent'}
                  streaming={anyRunning && i === blocks.length - 1 && activeStreams.length === 0}
                />
              )
            })}

            {/* Live streaming — one card per actively streaming agent */}
            {activeStreams.map((stream) => (
              <StreamingCard
                key={`stream-${stream.agentId}`}
                text={stream.text}
                agentId={stream.agentId}
                agentName={stream.agentName}
              />
            ))}

            <div ref={bottomRef} aria-hidden />
          </div>
        )}
      </div>

      {/* Agent chips for quick tagging */}
      {teamAgents.length > 0 && <AgentChips agents={mentionAgentList} onTag={handleChipTag} />}

      {/* Inline approval cards for team agents */}
      <InlineApprovalTray teamId={teamId} />

      {/* Composer */}
      <MessageComposer
        ref={composerRef as RefObject<MessageComposerHandle | null>}
        onSend={handleSend}
        disabled={!canSend}
        placeholder="Message team… (@name to target)"
        mentionAgents={mentionAgentList}
      />
    </div>
  )
}
