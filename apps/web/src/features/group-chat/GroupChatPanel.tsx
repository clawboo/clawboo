// GroupChatPanel — merged transcript from all team agents, sorted chronologically.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useBoardStore } from '@/stores/board'
import { useBooZeroStore } from '@/stores/booZero'
import { agentIdFromSessionKey, buildTeamSessionKey } from '@/lib/sessionUtils'
import { parseMention } from './parseMention'
import { useTeamChatStream } from './useTeamChatStream'
import { sendServerTeamMessage, stopServerTeam } from './serverTeamChatSend'
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
import { stripDelegationBlocks, stripPlanBlocks } from './delegationTags'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { InlineApprovalTray } from '@/features/approvals/InlineApprovalTray'
import { Sparkles, X } from 'lucide-react'
import { IconButton } from '@/features/shared/Button'
import { FIRST_TASK_FLAG, hasSeenFlag, markSeenFlag } from '@/lib/oneTimeFlag'

// ─── GroupChatPanel ──────────────────────────────────────────────────────────

// The one-time "guided first task" prefill — a friendly, dependency-free prompt
// that shows off a native team collaborating (it naturally triggers delegation).
const FIRST_TASK_SUGGESTION =
  'Plan a simple landing page for a new app, and split the work across the team.'

// How long a server-orchestrated team stays "busy" after the last SSE frame before
// the composer flips Stop → Send. DYNAMIC by whether a delegation cascade is in
// flight (any in-flight board task): during a cascade the long window bridges the
// gaps between delegated turns + the reflect-batch → synthesis latency (board
// lifecycle frames keep it alive); with NO in-flight task — a plain leader reply —
// a short window re-enables Send promptly so the user isn't locked out staring at a
// finished answer. (Before, the fixed 12s window locked the composer for 12s after
// EVERY reply.) Refreshed by every committed/delta/board frame.
const SERVER_BUSY_GRACE_CASCADE_MS = 12_000
const SERVER_BUSY_GRACE_IDLE_MS = 3_000

export function GroupChatPanel({
  teamId,
  embedded = false,
}: {
  teamId: string
  /**
   * When true, suppresses the local header (the unified `GroupChatViewHeader`
   * rendered above the graph + chat split owns team identity).
   */
  embedded?: boolean
}) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === teamId) ?? null)
  const agents = useFleetStore((s) => s.agents)
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
  // ── Server-orchestrated teams (the only mode) ────────────────────────────
  // Every team's chat is driven by the SERVER orchestrator: the browser is a THIN
  // CLIENT — it POSTs the message + renders the SSE transcript stream. There is no
  // browser-side team orchestration and no `client` requirement (native mode runs
  // `client === null`; an OpenClaw team keeps a live browser client for 1:1 chat /
  // exec approvals, but its team chat still rides the server engine).

  // Activity-window busy signal — the analog of the fleet-status `anyRunning`
  // (there is no Gateway pushing "running" for a native team). Busy while frames
  // stream OR within a grace window after the last SSE frame, so Stop stays stable
  // through the pauses between delegated turns. Refreshed by `bumpActivity` on every
  // frame; cleared by the effect below once idle past the grace.
  const [serverBusy, setServerBusy] = useState(false)
  const lastActivityRef = useRef(0)
  const bumpActivity = useCallback(() => {
    lastActivityRef.current = Date.now()
    setServerBusy(true)
  }, [])

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

  // ── Guided first task (one-time) ────────────────────────────────────────────
  // The first time a user lands in a server-orchestrated (native) team chat, pre-
  // fill the composer with a suggested prompt + show a dismissible hint so the
  // "premium first action" is obvious. Marked-once so it never repeats.
  const [firstTaskTip, setFirstTaskTip] = useState(false)
  const firstTaskFiredRef = useRef(false)
  useEffect(() => {
    if (firstTaskFiredRef.current) return
    if (teamAgents.length === 0) return
    if (hasSeenFlag(FIRST_TASK_FLAG)) return
    firstTaskFiredRef.current = true
    markSeenFlag(FIRST_TASK_FLAG)
    composerRef.current?.prefill(FIRST_TASK_SUGGESTION)
    setFirstTaskTip(true)
  }, [teamAgents.length])

  // Team-scoped sessionKeys for isolation from 1:1 agent chat
  const teamSessionKeys = useMemo(
    () => new Map(participants.map((a) => [a.id, buildTeamSessionKey(a.id, teamId)])),
    [participants, teamId],
  )

  // ── Server-orchestrated live transport (the only team-chat transport) ──────
  // The analog of `useGatewayEvents`: feed the team's SSE transcript stream
  // (committed turns + live token deltas) into the chat store. Every frame bumps
  // the activity-window busy signal. Browser team orchestration is retired.
  useTeamChatStream({ teamId, enabled: true, onActivity: bumpActivity })

  // ── Merge all team transcripts (using team-scoped sessionKeys) ────────────
  const mergedEntries = useMemo(() => {
    const all: TranscriptEntry[] = []
    // Dedup by entryId ACROSS session keys. `appendTranscript` dedups only WITHIN
    // one key, but the same entry can land in two members' transcripts with the same
    // entryId — e.g. an optimistic user bubble whose client-resolved target key
    // (@mention > leader > first) differs from the server's actual target key, so the
    // optimistic copy and the SSE-replayed copy sit under different keys. Without this
    // guard the message renders twice: a duplicate React key AND a visible duplicate
    // bubble (the "user message shown as 2 duplicates" symptom).
    const seen = new Set<string>()
    for (const agent of participants) {
      const teamSk = teamSessionKeys.get(agent.id)
      if (!teamSk) continue
      const entries = transcripts.get(teamSk)
      if (!entries) continue
      for (const e of entries) {
        if (seen.has(e.entryId)) continue
        seen.add(e.entryId)
        all.push(e)
      }
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
  // BoardTaskCards (from the projection store), not nested inside the source's turn.
  // Two blocks are dropped so the timeline stays clean:
  //  • A leader turn that is PURE `<delegate>` / `<plan>` (no prose, no thinking, no
  //    tools) strips to nothing — its work is shown as BoardTaskCards, so rendering
  //    it produced only the empty "<leader> · ~N tokens" ghost message.
  //  • A legacy `[Task Update]` meta (the internal reflection is no longer persisted
  //    to chat — it goes to the tracelog — but an older transcript may still hold one).
  const topLevelBlocks = useMemo(
    () =>
      blocks.filter((b) => {
        if (b.kind === 'assistant-turn') {
          if (b.thinking.length > 0 || b.tools.length > 0) return true
          const text = b.assistant?.text ?? ''
          return stripPlanBlocks(stripDelegationBlocks(text)).trim().length > 0
        }
        if (b.kind === 'meta') {
          const t = b.entry.text.trimStart()
          // Drop internal orchestration reflections — the batched "[Task Update]"
          // envelope and the per-task "✓ <agent> completed…" markers. These are no
          // longer persisted to chat (they go to the tracelog), but an older
          // transcript may still hold them, and dropping them keeps the timeline
          // clean. User-facing metas (a delivery-failure notice, a Boo Zero
          // acknowledgement) never start with these markers, so they pass through.
          if (t.startsWith('[Task Update]')) return false
          if (/^✓\s.+\bcompleted\b/.test(t)) return false
          return true
        }
        return true
      }),
    [blocks],
  )

  // ── Load persisted history for all participants (team-scoped sessionKeys) ──
  // Populates the merged transcript view on team-open. (The SSE stream also
  // full-replays committed turns on connect; this covers the render before the
  // stream lands, and dedup-by-entryId reconciles the two.)
  //
  // **CRITICAL — stable dep signature**: depend on a STRING derived from participant
  // ids, not the participants array reference. `participants` is a `useMemo` over
  // `[teamAgents, booZeroAgent]`, both Zustand selector results whose array reference
  // REALLOCATES on every fleet status patch during streaming — with the array as a
  // dep this effect would re-fire on every chat tick. The signature only changes when
  // the set of participant IDs actually changes (team switch, agent added/removed).
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
    let cancelled = false
    // Read the latest participants/teamSessionKeys via refs (not deps) — see the
    // stable-dep-signature rationale above (the array refs reallocate on every fleet
    // patch; keying the fetch on the id signature avoids re-firing per chat tick).
    for (const agent of participantsRef.current) {
      const teamSk = teamSessionKeysRef.current.get(agent.id)
      if (!teamSk) continue
      const existing = useChatStore.getState().transcripts.get(teamSk)
      if (existing && existing.length > 0) continue

      void fetch(`/api/chat-history?sessionKey=${encodeURIComponent(teamSk)}`)
        .then((r) => r.json())
        .then(({ entries: historical }: { entries?: TranscriptEntry[] }) => {
          if (cancelled) return
          if (historical && historical.length > 0) {
            useChatStore.getState().appendTranscript(teamSk, historical)
          }
        })
        .catch(() => {})
    }

    return () => {
      cancelled = true
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

  // ── Activity-window busy clear (server teams) ─────────────────────────────
  // Poll while busy: once no SSE frame has arrived for `SERVER_BUSY_GRACE_MS` AND
  // nothing is actively streaming, the cascade has settled → flip Stop back to Send.
  // Each frame refreshes `lastActivityRef` (via `bumpActivity`), so a multi-step
  // cascade keeps the window alive across the gaps between turns.
  useEffect(() => {
    if (!serverBusy) return
    const id = setInterval(() => {
      // A cascade is in flight when the team has any non-terminal board task; then
      // hold Stop through the (frame-quiet) reflect → synthesis gap. Otherwise it was
      // a plain reply — clear promptly. Read live (getState) so the tick always sees
      // the latest board projection without re-subscribing the interval.
      const tasks = useBoardStore.getState().tasksByTeam.get(teamId)
      const cascadeActive = tasks
        ? [...tasks.values()].some((t) => t.status !== 'done' && t.status !== 'cancelled')
        : false
      const grace = cascadeActive ? SERVER_BUSY_GRACE_CASCADE_MS : SERVER_BUSY_GRACE_IDLE_MS
      if (Date.now() - lastActivityRef.current > grace && activeStreams.length === 0) {
        setServerBusy(false)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [serverBusy, activeStreams.length, teamId])

  // Reset the busy signal when switching teams.
  useEffect(() => {
    setServerBusy(false)
    lastActivityRef.current = 0
  }, [teamId])

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

  // The fleet store never reports "running" for a server-orchestrated team (no Gateway
  // pushing status) — derive it from the SSE activity window.
  const running = serverBusy

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
      // Dismiss the guided first-task hint once the user actually sends.
      setFirstTaskTip(false)
      // `/reset` / `/new` — deliberately NOT a team-chat command: a team has no
      // single session to reset (each teammate + Boo Zero has its own, all
      // server-orchestrated). Intercept it here so it gives clear feedback rather
      // than being sent to the leader as a literal "/reset" message. (1:1 agent
      // chat keeps `/reset`, where it maps to a real `sessions.create`.)
      const cmd = message.trim().toLowerCase()
      if (cmd === '/reset' || cmd === '/new') {
        useToastStore.getState().addToast({
          message: 'Reset isn’t available in team chat.',
          type: 'error',
        })
        return
      }
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

      // ── Thin-client REST send (the only team-chat path) ────────────────────
      // Resolve the target client-side so the optimistic bubble lands under the
      // SAME session key the server routes to (`sendServerTeamMessage` passes it as
      // the EXPLICIT target, which the server honors — no divergence). Priority
      // mirrors the server: @mention > Boo Zero > leader > first. Boo Zero is now
      // runtime-neutral (`GET /api/agents` `defaultId`): a native-first install
      // identifies the DEFAULT-NATIVE Boo Zero here, so native teams route to it too.
      const { targetAgentId } = parseMention(message, mentionAgentList)
      const targetId =
        targetAgentId ?? booZeroAgent?.id ?? team?.leaderAgentId ?? teamAgents[0]?.id
      if (!targetId) return
      const targetSk = teamSessionKeys.get(targetId)
      if (!targetSk) return
      // Optimistic busy → the composer flips to Stop immediately.
      lastActivityRef.current = Date.now()
      setServerBusy(true)
      await sendServerTeamMessage({
        teamId,
        targetAgentId: targetId,
        targetSessionKey: targetSk,
        message,
      })
    },
    [
      teamId,
      team?.leaderAgentId,
      booZeroAgent,
      mentionAgentList,
      teamAgents,
      participants,
      teamSessionKeys,
    ],
  )

  // ── Chip tag handler ───────────────────────────────────────────────────────
  const handleChipTag = useCallback((agentName: string) => {
    composerRef.current?.insertMention(agentName)
  }, [])

  // No `client` requirement — the server owns the run (native mode runs client=null).
  const canSend = teamAgents.length > 0 && !serverBusy
  const isEmpty = topLevelBlocks.length === 0 && activeStreams.length === 0

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div data-testid="group-chat-panel" className="flex h-full flex-col">
      {/* Header is owned by `GroupChatViewHeader` when embedded. */}
      {!embedded && (
        <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
          {team && (
            <span
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[16px]"
              style={{ background: `${team.color}22` }}
            >
              {team.icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
              {team?.name ?? 'Group Chat'}
            </h2>
            <p className="font-data text-[10px] text-foreground/45">
              {teamAgents.length} agent{teamAgents.length !== 1 ? 's' : ''}
            </p>
          </div>
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${connectionStatus === 'connected' ? 'bg-mint' : 'bg-foreground/25'}`}
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
                    className="font-data flex h-[42px] w-[42px] items-center justify-center rounded-full bg-foreground/10 text-[11px] font-semibold text-foreground/60 ring-2 ring-background"
                    style={{ marginLeft: -10 }}
                  >
                    +{participants.length - 4}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <p
                className="text-[17px] font-bold text-foreground/90"
                style={{
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '-0.01em',
                }}
              >
                {team?.name ? `Welcome to ${team.name}` : 'Welcome to the team'}
              </p>
              <p className="max-w-[300px] text-[13px] leading-relaxed text-foreground/50">
                Send a message to start, or ping a teammate with{' '}
                <span className="font-data text-foreground/60">@</span>.
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
                        running && blockIdx === lastBlockSeenIdx && activeStreams.length === 0
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

      {/* Guided first task — one-time prefilled-composer hint */}
      {firstTaskTip && (
        <div
          className="mx-3 mb-2 flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary/[0.06] px-3.5 py-2.5"
          data-testid="first-task-tip"
        >
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={2} />
          <div className="flex-1 text-[12px] leading-relaxed text-foreground/80">
            <span className="font-semibold text-foreground">Try your first task.</span> We filled in
            a prompt below — press Enter to send it to your team, or edit it first.
          </div>
          <IconButton
            variant="ghost"
            size="sm"
            label="Dismiss"
            onClick={() => setFirstTaskTip(false)}
            className="shrink-0"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </IconButton>
        </div>
      )}

      {/* Composer */}
      <MessageComposer
        ref={composerRef as RefObject<MessageComposerHandle | null>}
        onSend={handleSend}
        disabled={!canSend}
        placeholder="Message team… (@name to target)"
        mentionAgents={mentionAgentList}
        // Team chat handles `/rule` (save a durable team rule). It does NOT handle
        // `/reset` — a team has no single session to reset — so that hint is omitted.
        commands={[{ k: '/rule', label: 'save rule' }]}
        // Stop button — replaces Send while the team is working (running OR
        // mid-stream). POSTs /chat/stop; the server owns the abort + clean release.
        isActive={running || activeStreams.length > 0}
        onStop={() => {
          setServerBusy(false)
          void stopServerTeam({ teamId, sessionKeys: Array.from(teamSessionKeys.values()) })
        }}
      />
    </div>
  )
}
