// GroupChatPanel — merged transcript from all team agents, sorted chronologically.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useBoardStore } from '@/stores/board'
import { resolveTeamInternalLead } from '@/lib/resolveTeamLeader'
import { useBooZeroStore } from '@/stores/booZero'
import { agentIdFromSessionKey, buildTeamSessionKey } from '@/lib/sessionUtils'
import { sendGroupChatMessage } from './groupChatSendOperation'
import { useBoardOrchestration } from './useBoardOrchestration'
import { stopAllInTeam } from '@/features/chat/stopChatOperation'
import { appendRule, fetchTeamRules, parseRuleCommand, saveTeamRules } from '@/lib/teamRules'
import { nextSeq } from '@/lib/sequenceKey'
import { useToastStore } from '@/stores/toast'
import {
  groupEntriesToBlocks,
  UserMessageCard,
  AssistantTurnCard,
  StreamingCard,
  MetaMessageCard,
  MessageComposer,
  NEAR_BOTTOM_PX,
  isFollowupBlock,
  blockMarginClass,
  type MessageComposerHandle,
} from '@/features/chat/chatComponents'
import { AgentChips } from './AgentChips'
import { BoardTaskCard } from './BoardTaskCard'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
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
  // Subscribe to stream-start timestamps so live StreamingCards can position
  // themselves at their chronological slot in the merged timeline (not always-
  // at-the-end). After commit, the committed entry takes the same `timestampMs`
  // value — zero visible re-arrangement.
  const streamStartedAtMap = useChatStore((s) => s.streamStartedAt)

  const teamAgents = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const booZeroAgent = useMemo(
    () => (booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null),
    [agents, booZeroAgentId],
  )
  // Team-internal lead (CTO, Team Lead, etc., detected via
  // `detectGenuineLeader` at deploy time). Surfaced separately for routing
  // under Boo Zero — `sendGroupChatMessage` and `useBoardOrchestration`
  // each prefer `booZeroAgent` over this when present.
  const teamInternalLeadId = resolveTeamInternalLead(teamId, team?.leaderAgentId ?? null, agents)

  // ── Stop signal ─────────────────────────────────────────────────────────
  // Monotonic counter bumped when the Stop button is pressed. Feeds into
  // `useBoardOrchestration` below so the hook can cancel in-flight delegation
  // work. The `chat.abort` RPCs themselves are fired separately by
  // `stopAllInTeam` — this signal only owns the orchestration-side cleanup.
  const [stopSignal, setStopSignal] = useState(0)

  // ── History-hydration gate ──────────────────────────────────────────────
  // `useBoardOrchestration` must NOT process historical entries that arrive
  // via `/api/chat-history` hydration as if they were new — that's the root
  // cause of the "7-hour-later cascade of intros / wake messages" we saw in
  // production. The hook seeds its baseline on mount; if it mounts before
  // hydration completes, the seed reads `0` and every hydrated entry trips
  // the subscription's "new entries" branch.
  //
  // We flip this flag to `true` AFTER `Promise.allSettled` over all per-
  // participant history fetches resolves. The hook is gated on `enabled =
  // connected && historyHydrated` so it only mounts (and thus only seeds)
  // when the transcript is in its final settled shape.
  //
  // Resets on `teamId` change so reopening a different team waits for THAT
  // team's hydration cycle. Falls open after a 5s timeout as a safety net —
  // a hung fetch shouldn't lock the team chat orchestration forever.
  const [historyHydrated, setHistoryHydrated] = useState(false)

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

  // ── Event-driven board orchestration ──────────────────────────────────────
  // The structured, lifecycle-event-driven orchestration path. Observes each
  // participant's session via the OpenClaw RuntimeAdapter and turns structured
  // delegations into durable board tasks. Gated on the Gateway connection +
  // history hydration so it never replays historical entries as new.
  useBoardOrchestration({
    teamId,
    teamAgents,
    booZeroAgent,
    client,
    teamSessionKeys,
    enabled: connectionStatus === 'connected' && historyHydrated,
    stopSignal,
  })

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

  // Every committed turn renders at top level — delegations surface as durable
  // BoardTaskCards (from the projection store), not nested inside the source's
  // turn. (`topLevelBlocks` alias kept for the render loop's local naming.)
  const topLevelBlocks = blocks

  // ── Load persisted history for all participants (team-scoped sessionKeys) ──
  // Tracks completion via `historyHydrated`: `useBoardOrchestration` is gated
  // on this flag so it doesn't see the hydration-time appends as "new"
  // entries and replay stale wake/relay messages (the 7-hour-cascade bug).
  // The 5s safety timeout is a fallback — if a fetch hangs forever we still
  // want orchestration to come online eventually.
  //
  // **CRITICAL — stable dep signature**: depend on a STRING derived from
  // participant ids, not the participants array reference. `participants`
  // is a `useMemo` over `[teamAgents, booZeroAgent]`, both of which are
  // Zustand selector results — the array reference REALLOCATES on every
  // fleet store update (every agent status patch during streaming). With
  // the array as a dep, this effect re-fired on every chat tick, resetting
  // `historyHydrated` to `false` → disabling orchestration → the
  // `useBoardOrchestration` subscription kept unmounting and remounting.
  // The string signature only changes when the set of participant IDs
  // actually changes (e.g., team switch, agent deleted).
  const participantSignature = useMemo(
    () =>
      participants
        .map((a) => a.id)
        .sort()
        .join('|'),
    [participants],
  )
  // Stash the latest array/map refs so the effect can read them at fire
  // time without participating in the dependency list. We DELIBERATELY do
  // NOT include `participants` / `teamSessionKeys` in the effect's deps —
  // see the multi-line rationale in the effect body below.
  const participantsRef = useRef(participants)
  participantsRef.current = participants
  const teamSessionKeysRef = useRef(teamSessionKeys)
  teamSessionKeysRef.current = teamSessionKeys
  useEffect(() => {
    setHistoryHydrated(false)
    let cancelled = false

    // Read the latest participants/teamSessionKeys via refs (not deps). The
    // `participants` array reference reallocates whenever the fleet-store
    // agents array reallocates (which happens on EVERY agent status patch
    // during streaming — a chat tick can fire 10+ patches per second), and
    // `teamSessionKeys` is downstream of that. If we put them in the deps,
    // this effect re-fires on every chat tick, resets `historyHydrated` to
    // `false`, and the `useBoardOrchestration` subscription gated on it
    // unmounts/remounts in a tight loop. The `participantSignature` string
    // only changes when the set of participant IDs actually changes (team
    // switch, agent added/removed), which is the right granularity for
    // "re-hydrate history".
    const fetches: Promise<unknown>[] = []
    for (const agent of participantsRef.current) {
      const teamSk = teamSessionKeysRef.current.get(agent.id)
      if (!teamSk) continue
      const existing = useChatStore.getState().transcripts.get(teamSk)
      if (existing && existing.length > 0) continue

      fetches.push(
        fetch(`/api/chat-history?sessionKey=${encodeURIComponent(teamSk)}`)
          .then((r) => r.json())
          .then(({ entries: historical }: { entries?: TranscriptEntry[] }) => {
            if (cancelled) return
            if (historical && historical.length > 0) {
              useChatStore.getState().appendTranscript(teamSk, historical)
            }
          })
          .catch(() => {}),
      )
    }

    // Safety timeout — if a fetch hangs we still want orchestration online.
    const timer = setTimeout(() => {
      if (!cancelled) setHistoryHydrated(true)
    }, 5000)

    void Promise.allSettled(fetches).then(() => {
      if (cancelled) return
      clearTimeout(timer)
      setHistoryHydrated(true)
    })

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [participantSignature])

  // ── Board projection load ─────────────────────────────────────────────────
  // The chat renders task cards from the board projection store (the canonical
  // source), so on a refresh it re-loads from SQLite-backed REST (refresh-
  // survival). Keyed on the teamId STRING, NEVER on the participants/tasks
  // arrays (those reallocate on every fleet patch and would re-fire this in a
  // loop — the rehydrate-cascade hazard).
  useEffect(() => {
    void useBoardStore.getState().load(teamId)
  }, [teamId])

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
  // Every participant's live stream renders as a top-level StreamingCard.
  const activeStreams = useMemo(() => {
    const streams: {
      agentId: string
      agentName: string
      text: string
      sessionKey: string
      streamStartedAt: number
    }[] = []
    for (const agent of participants) {
      const teamSk = teamSessionKeys.get(agent.id)
      if (!teamSk) continue
      const text = streamingTextMap.get(teamSk)
      if (text != null) {
        // Stream-start anchors the live card's chronological position in
        // the timeline. Falls back to "now" on the first render after a
        // chunk lands but before the store update commits (vanishingly
        // rare in practice — Zustand updates are synchronous).
        const streamStartedAt = streamStartedAtMap.get(teamSk) ?? Date.now()
        streams.push({
          agentId: agent.id,
          agentName: agent.name,
          text,
          sessionKey: teamSk,
          streamStartedAt,
        })
      }
    }
    return streams
  }, [participants, teamSessionKeys, streamingTextMap, streamStartedAtMap])

  // ── Interleaved render timeline ───────────────────────────────────────────
  // Committed blocks and active streaming cards merged into ONE chronologically-
  // sorted list. Each item carries the timestamp at which the leader's
  // response BEGAN — committed entries from `appendOutputLines` use the same
  // stream-start anchor, so a streaming card and its eventual committed entry
  // occupy the same chronological slot. No visible re-arrangement on commit.
  //
  // Board projection (flag-on) — READ-ONLY in render. The Map ref changes on
  // every change-feed update (intended re-render); it MUST NOT feed any effect.
  const boardTasksMap = useBoardStore((s) => s.tasksByTeam.get(teamId))
  const boardTaskList = useMemo(
    () =>
      boardTasksMap ? [...boardTasksMap.values()].filter((t) => t.status !== 'cancelled') : [],
    [boardTasksMap],
  )
  type RenderItem =
    | { kind: 'block'; block: (typeof topLevelBlocks)[number]; ts: number; tieKey: number }
    | { kind: 'stream'; stream: (typeof activeStreams)[number]; ts: number; tieKey: number }
    | { kind: 'board-task'; task: (typeof boardTaskList)[number]; ts: number; tieKey: number }
  const renderItems = useMemo<RenderItem[]>(() => {
    const blockTs = (block: (typeof topLevelBlocks)[number]): number => {
      // AssistantBlock carries its own `timestampMs`; meta/user blocks
      // anchor on their underlying entry. Fall back to 0 only as a defensive
      // last resort.
      if (block.kind === 'assistant-turn') return block.timestampMs ?? 0
      return block.entry.timestampMs ?? 0
    }
    const items: RenderItem[] = []
    for (let i = 0; i < topLevelBlocks.length; i++) {
      const block = topLevelBlocks[i]!
      items.push({ kind: 'block', block, ts: blockTs(block), tieKey: i })
    }
    for (const stream of activeStreams) {
      // Streams sort AFTER committed blocks with the same timestamp because
      // the committed entry IS what the stream produced — once it commits,
      // the stream disappears and the committed block takes the slot. While
      // streaming, the slight tieKey bump keeps the live card visually below
      // any same-timestamp tool/thinking block that already committed.
      items.push({
        kind: 'stream',
        stream,
        ts: stream.streamStartedAt,
        tieKey: Number.MAX_SAFE_INTEGER,
      })
    }
    // Board task cards (flag-on) interleave by createdAt — the durable,
    // refresh-surviving record of each delegation + its live status.
    for (const task of boardTaskList) {
      items.push({ kind: 'board-task', task, ts: task.createdAt, tieKey: 1 })
    }
    items.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts
      return a.tieKey - b.tieKey
    })
    return items
  }, [topLevelBlocks, activeStreams, boardTaskList])

  const anyRunning = teamAgents.some((a) => a.status === 'running')

  useEffect(() => {
    if (pinnedRef.current) scheduleScroll()
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [topLevelBlocks.length, activeStreams.length, scheduleScroll])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }, [])

  // ── Send handler ──────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (message: string) => {
      // `/rule <text>` — intercept BEFORE routing to any agent. Appends the
      // text to the team's durable rules in SQLite, drops a meta entry in
      // every team session's transcript so the user gets visible
      // confirmation, and short-circuits without sending to the Gateway.
      const ruleText = parseRuleCommand(message)
      if (ruleText !== null) {
        try {
          const existing = await fetchTeamRules(teamId)
          const updated = appendRule(existing, ruleText)
          const ok = await saveTeamRules(teamId, updated)
          if (!ok) {
            useToastStore.getState().addToast({
              message: 'Could not save team rule. Try again?',
              type: 'error',
            })
            return
          }
          // Drop a single meta confirmation into the first participant's
          // session so the merged team view shows ONE entry, not N
          // duplicates. The rule itself is global to the team (in SQLite),
          // so the per-session anchor is just a visual breadcrumb.
          const firstAgent = participants[0]
          const firstSk = firstAgent ? teamSessionKeys.get(firstAgent.id) : null
          if (firstSk) {
            useChatStore.getState().appendTranscript(firstSk, [
              {
                entryId: crypto.randomUUID(),
                runId: null,
                sessionKey: firstSk,
                kind: 'meta',
                role: 'system',
                text: `Rule saved for team: ${ruleText}`,
                source: 'local-send',
                timestampMs: Date.now(),
                sequenceKey: nextSeq(),
                confirmed: true,
                fingerprint: crypto.randomUUID(),
              },
            ])
          }
          useToastStore.getState().addToast({
            message: 'Team rule saved.',
            type: 'success',
          })
        } catch {
          useToastStore.getState().addToast({
            message: 'Could not save team rule. Try again?',
            type: 'error',
          })
        }
        return
      }

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
    [
      client,
      teamId,
      team?.name,
      teamInternalLeadId,
      teamAgents,
      booZeroAgent,
      userIntroText,
      participants,
      teamSessionKeys,
    ],
  )

  // ── Chip tag handler ───────────────────────────────────────────────────────
  const handleChipTag = useCallback((agentName: string) => {
    composerRef.current?.insertMention(agentName)
  }, [])

  const canSend = Boolean(
    client && connectionStatus === 'connected' && teamAgents.length > 0 && !anyRunning,
  )
  const isEmpty = topLevelBlocks.length === 0 && activeStreams.length === 0

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div data-testid="group-chat-panel" className="flex h-full flex-col">
      {/* Header is owned by `GroupChatViewHeader` when embedded. */}
      {!embedded && (
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
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
          <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
            {/* Team mascot stack — up to 4 avatars overlapping, mirroring
                the GroupChatRow visual so the empty state visually anchors
                to the same team identity the user clicked to get here. */}
            {participants.length > 0 && (
              <div className="flex items-center">
                {participants.slice(0, 4).map((agent, idx) => (
                  <div
                    key={agent.id}
                    className="rounded-full ring-2 ring-background"
                    style={{
                      marginLeft: idx === 0 ? 0 : -10,
                      zIndex: participants.length - idx,
                    }}
                  >
                    <AgentBooAvatar agentId={agent.id} size={42} />
                  </div>
                ))}
                {participants.length > 4 && (
                  <div
                    className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-foreground/10 font-mono text-[11px] font-semibold text-foreground/60 ring-2 ring-background"
                    style={{ marginLeft: -10 }}
                  >
                    +{participants.length - 4}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <p
                className="text-[16px] font-semibold text-foreground/85"
                style={{
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '-0.01em',
                }}
              >
                {team?.name ? `Welcome to ${team.name}` : 'Welcome to the team'}
              </p>
              <p className="max-w-[300px] text-[12px] leading-relaxed text-foreground/45">
                Send a message to start, or ping a teammate with{' '}
                <span className="font-mono text-foreground/55">@</span>.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col pb-2">
            {(() => {
              // Track previous BLOCK across the loop (not previous stream)
              // so the same-author follow-up grouping survives stream
              // interruptions. Streams are always rendered with the
              // "new section" margin — they don't participate in the
              // Slack/Discord/iMessage author-grouping rhythm.
              let prevBlock: (typeof topLevelBlocks)[number] | null = null
              let prevOwnerAgentId: string | null = null
              let blockIdx = -1
              const lastBlockSeenIdx = topLevelBlocks.length - 1

              return renderItems.map((item, i) => {
                if (item.kind === 'stream') {
                  const stream = item.stream
                  return (
                    <div
                      key={`stream-wrap-${stream.agentId}-${stream.sessionKey}`}
                      className={i === 0 ? '' : 'mt-7'}
                    >
                      <StreamingCard
                        text={stream.text}
                        agentId={stream.agentId}
                        agentName={stream.agentName}
                      />
                    </div>
                  )
                }
                if (item.kind === 'board-task') {
                  return (
                    <div key={`board-task-${item.task.id}`} className={i === 0 ? '' : 'mt-3'}>
                      <BoardTaskCard task={item.task} />
                    </div>
                  )
                }
                blockIdx += 1
                const block = item.block
                let currentOwnerAgentId: string | null = null
                if (block.kind === 'assistant-turn') {
                  const firstEntry = block.assistant ?? block.thinking[0] ?? block.tools[0] ?? null
                  currentOwnerAgentId = firstEntry
                    ? agentIdFromSessionKey(firstEntry.sessionKey)
                    : null
                }
                const isFollowup = isFollowupBlock(
                  prevBlock,
                  block,
                  prevOwnerAgentId,
                  currentOwnerAgentId,
                )
                // Use `i === 0` (timeline position) for the "first item
                // has no top margin" check; `blockIdx` only matters for
                // the followup-vs-new-author choice.
                const margin = i === 0 ? '' : blockMarginClass(blockIdx, isFollowup)
                prevBlock = block
                prevOwnerAgentId = currentOwnerAgentId

                if (block.kind === 'meta') {
                  return (
                    <div key={block.entry.entryId} className={margin}>
                      <MetaMessageCard entry={block.entry} />
                    </div>
                  )
                }
                if (block.kind === 'user') {
                  const targetId = agentIdFromSessionKey(block.entry.sessionKey)
                  const targetAgent = targetId ? agentLookup.get(targetId) : null
                  return (
                    <div key={block.entry.entryId} className={margin}>
                      <UserMessageCard
                        entry={block.entry}
                        targetAgentName={targetAgent?.name}
                        knownAgentNames={knownAgentNames}
                      />
                    </div>
                  )
                }
                const ownerAgent = currentOwnerAgentId ? agentLookup.get(currentOwnerAgentId) : null
                return (
                  <div key={`turn-${blockIdx}`} className={margin}>
                    <AssistantTurnCard
                      block={block}
                      agentId={ownerAgent?.id ?? 'unknown'}
                      agentName={ownerAgent?.name ?? 'Agent'}
                      streaming={
                        anyRunning && blockIdx === lastBlockSeenIdx && activeStreams.length === 0
                      }
                      teamId={teamId}
                      isFollowup={isFollowup}
                    />
                  </div>
                )
              })
            })()}

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
