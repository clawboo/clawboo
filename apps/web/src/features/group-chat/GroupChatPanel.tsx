// GroupChatPanel — merged transcript from all team agents, sorted chronologically.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { resolveTeamLeader } from '@/lib/resolveTeamLeader'
import { agentIdFromSessionKey } from '@/lib/sessionUtils'
import { sendGroupChatMessage } from './groupChatSendOperation'
import {
  groupEntriesToBlocks,
  UserMessageCard,
  AssistantTurnCard,
  StreamingCard,
  MetaMessageCard,
  MessageComposer,
  NEAR_BOTTOM_PX,
} from '@/features/chat/chatComponents'

// ─── GroupChatPanel ──────────────────────────────────────────────────────────

export function GroupChatPanel({ teamId }: { teamId: string }) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === teamId) ?? null)
  const agents = useFleetStore((s) => s.agents)
  const client = useConnectionStore((s) => s.client)
  const connectionStatus = useConnectionStore((s) => s.status)
  const transcripts = useChatStore((s) => s.transcripts)
  const streamingTextMap = useChatStore((s) => s.streamingText)

  const teamAgents = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])
  const leaderAgentId = resolveTeamLeader(teamId, team?.leaderAgentId ?? null, agents)

  // Agent lookup for resolving names from sessionKeys
  const agentLookup = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const a of teamAgents) {
      map.set(a.id, { id: a.id, name: a.name })
    }
    return map
  }, [teamAgents])

  // ── Merge all team transcripts ────────────────────────────────────────────
  const mergedEntries = useMemo(() => {
    const all: TranscriptEntry[] = []
    for (const agent of teamAgents) {
      if (!agent.sessionKey) continue
      const entries = transcripts.get(agent.sessionKey)
      if (entries) all.push(...entries)
    }
    all.sort((a, b) => {
      const tsDiff = (a.timestampMs ?? 0) - (b.timestampMs ?? 0)
      if (tsDiff !== 0) return tsDiff
      return a.sequenceKey - b.sequenceKey
    })
    return all
  }, [teamAgents, transcripts])

  const blocks = useMemo(() => groupEntriesToBlocks(mergedEntries), [mergedEntries])

  // ── Load persisted history for all team agents ────────────────────────────
  useEffect(() => {
    for (const agent of teamAgents) {
      if (!agent.sessionKey) continue
      const existing = useChatStore.getState().transcripts.get(agent.sessionKey)
      if (existing && existing.length > 0) continue

      fetch(`/api/chat-history?sessionKey=${encodeURIComponent(agent.sessionKey)}`)
        .then((r) => r.json())
        .then(({ entries: historical }: { entries?: TranscriptEntry[] }) => {
          if (historical && historical.length > 0) {
            useChatStore.getState().appendTranscript(agent.sessionKey!, historical)
          }
        })
        .catch(() => {})
    }
  }, [teamAgents])

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

  // Collect all streaming texts for team agents
  const activeStreams = useMemo(() => {
    const streams: { agentId: string; agentName: string; text: string }[] = []
    for (const agent of teamAgents) {
      if (!agent.sessionKey) continue
      const text = streamingTextMap.get(agent.sessionKey)
      if (text != null) {
        streams.push({ agentId: agent.id, agentName: agent.name, text })
      }
    }
    return streams
  }, [teamAgents, streamingTextMap])

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
        leaderAgentId,
        teamAgents,
        message,
      })
    },
    [client, teamId, leaderAgentId, teamAgents],
  )

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
            {team?.name ?? 'Team Chat'}
          </h2>
          <p className="text-[10px] text-secondary/50">
            {teamAgents.length} agent{teamAgents.length !== 1 ? 's' : ''}
          </p>
        </div>
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

      {/* Composer */}
      <MessageComposer
        onSend={handleSend}
        disabled={!canSend}
        placeholder="Message team… (@name to target)"
      />
    </div>
  )
}
