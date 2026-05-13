// GroupChatPanel — merged transcript from all team agents, sorted chronologically.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { resolveTeamInternalLead } from '@/lib/resolveTeamLeader'
import { useBooZeroStore } from '@/stores/booZero'
import { agentIdFromSessionKey, buildTeamSessionKey } from '@/lib/sessionUtils'
import { sendGroupChatMessage } from './groupChatSendOperation'
import { useTeamOrchestration } from './useTeamOrchestration'
import { stopAllInTeam } from '@/features/chat/stopChatOperation'
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

// ─── GroupChatPanel ──────────────────────────────────────────────────────────

export function GroupChatPanel({
  teamId,
  userIntroText,
  embedded = false,
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
  /**
   * When true, suppresses the local header (the unified `GroupChatViewHeader`
   * rendered above the graph + chat split owns team identity).
   */
  embedded?: boolean
}) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === teamId) ?? null)
  const agents = useFleetStore((s) => s.agents)
  const client = useConnectionStore((s) => s.client)
  const connectionStatus = useConnectionStore((s) => s.status)
  const transcripts = useChatStore((s) => s.transcripts)
  const streamingTextMap = useChatStore((s) => s.streamingText)

  const teamAgents = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const booZeroAgent = useMemo(
    () => (booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null),
    [agents, booZeroAgentId],
  )
  // Team-internal lead (CTO, Team Lead, etc., detected via
  // `detectGenuineLeader` at deploy time). Surfaced separately for relay
  // routing under Boo Zero — `sendGroupChatMessage` and `useTeamOrchestration`
  // each prefer `booZeroAgent` over this when present.
  const teamInternalLeadId = resolveTeamInternalLead(teamId, team?.leaderAgentId ?? null, agents)

  // ── Stop signal ─────────────────────────────────────────────────────────
  // Monotonic counter bumped when the Stop button is pressed. Feeds into
  // `useTeamOrchestration` below so the hook can cancel its 500ms debounce
  // timer and clear its bookkeeping refs. The `chat.abort` RPCs themselves
  // are fired separately by `stopAllInTeam` — this signal only owns the
  // orchestration-side cleanup.
  const [stopSignal, setStopSignal] = useState(0)

  // ── Team orchestration (delegation detection + context relay) ───────────
  //
  // Always on — relay + delegation routing is the whole point of a team
  // chat, so there's no user toggle. The hook is gated only by the
  // Gateway connection: when disconnected, the hook stays quiet to avoid
  // queuing relays that would fail to send anyway.
  useTeamOrchestration({
    teamId,
    // Pass the actual team name — used by the silent-resume wake message
    // in the wake-on-relay path so the body reads `team "Dev Team"` rather
    // than `team "<uuid>"`.
    teamName: team?.name ?? 'Team',
    teamAgents,
    // Pass the team-internal lead — Boo Zero is the actual relay hub when
    // present, so the orchestration hook prefers Boo Zero (see its impl).
    leaderAgentId: teamInternalLeadId,
    booZeroAgent,
    client,
    enabled: connectionStatus === 'connected',
    userIntroText,
    stopSignal,
  })

  // "Effective participants" — DB team members + Boo Zero (when present),
  // deduplicated by agent id.
  //
  // Boo Zero is teamless in the DB and SHOULD NOT appear in `teamAgents`,
  // but the auto-migrate path in `GatewayBootstrap` (which can assign
  // unassigned agents to a "Default" team) plus any future migration that
  // attaches Boo Zero to a team could cause it to leak into both
  // `teamAgents` AND the explicit `booZeroAgent` spread. Two copies of the
  // same agent in `participants` causes `mergedEntries` to pull the same
  // transcript twice — a contributing factor to the production triple-
  // render bug. Dedupe by id defensively.
  //
  // Every downstream iteration (teamSessionKeys, mergedEntries, agentLookup,
  // mentionAgentList, knownAgentNames, persisted-history-load, activeStreams)
  // walks `participants` directly, so a single dedup here covers them all.
  const participants = useMemo(() => {
    const combined = booZeroAgent ? [...teamAgents, booZeroAgent] : teamAgents
    const seen = new Set<string>()
    const out: typeof combined = []
    for (const a of combined) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      out.push(a)
    }
    return out
  }, [teamAgents, booZeroAgent])

  // Agent lookup for resolving names from sessionKeys
  const agentLookup = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const a of participants) {
      map.set(a.id, { id: a.id, name: a.name })
    }
    return map
  }, [participants])

  // For @mention autocomplete and visual rendering — include Boo Zero so
  // the user can `@Boo Zero` explicitly in a team chat to address it.
  const mentionAgentList = useMemo(
    () => participants.map((a) => ({ id: a.id, name: a.name })),
    [participants],
  )
  const knownAgentNames = useMemo(() => participants.map((a) => a.name), [participants])
  const composerRef = useRef<MessageComposerHandle>(null)

  // Team-scoped sessionKeys for isolation from 1:1 agent chat
  const teamSessionKeys = useMemo(
    () => new Map(participants.map((a) => [a.id, buildTeamSessionKey(a.id, teamId)])),
    [participants, teamId],
  )

  // ── Merge all team transcripts (using team-scoped sessionKeys) ────────────
  const mergedEntries = useMemo(() => {
    const all: TranscriptEntry[] = []
    for (const agent of participants) {
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
  }, [participants, teamSessionKeys, transcripts])

  const blocks = useMemo(() => groupEntriesToBlocks(mergedEntries), [mergedEntries])

  // ── Load persisted history for all participants (team-scoped sessionKeys) ──
  useEffect(() => {
    for (const agent of participants) {
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
  }, [participants, teamSessionKeys])

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

  // Collect all streaming texts for participants (using team-scoped sessionKeys).
  // Boo Zero's stream lands in the merged transcript with its own avatar/name.
  const activeStreams = useMemo(() => {
    const streams: { agentId: string; agentName: string; text: string }[] = []
    for (const agent of participants) {
      const teamSk = teamSessionKeys.get(agent.id)
      if (!teamSk) continue
      const text = streamingTextMap.get(teamSk)
      if (text != null) {
        streams.push({ agentId: agent.id, agentName: agent.name, text })
      }
    }
    return streams
  }, [participants, teamSessionKeys, streamingTextMap])

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
        // `leaderAgentId` here is the team-internal lead (Boo-Zero-fallback);
        // `sendGroupChatMessage` prefers `booZeroAgent` over this as the
        // routing target.
        leaderAgentId: teamInternalLeadId,
        teamAgents,
        booZeroAgent,
        message,
        displayText: message, // raw message including @mention for transcript display
        userIntroText,
      })
    },
    [client, teamId, team?.name, teamInternalLeadId, teamAgents, booZeroAgent, userIntroText],
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
      {/* Header is owned by `GroupChatViewHeader` when embedded. */}
      {!embedded && (
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
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${connectionStatus === 'connected' ? 'bg-mint' : 'bg-secondary/40'}`}
          />
        </div>
      )}

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
        // Stop button — replaces Send while ANY agent on the team is
        // running OR mid-stream. Bumping `stopSignal` first ensures the
        // orchestration hook tears down its in-flight state BEFORE the
        // `chat.abort` events from the Gateway start landing.
        isActive={anyRunning || activeStreams.length > 0}
        onStop={() => {
          setStopSignal((n) => n + 1)
          void stopAllInTeam({ client, teamId, participants, teamSessionKeys })
        }}
      />
    </div>
  )
}
