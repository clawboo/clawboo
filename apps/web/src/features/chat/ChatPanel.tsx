import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useBooZeroStore } from '@/stores/booZero'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useTeamStore } from '@/stores/team'
import { sendChatMessage } from './chatSendOperation'
import { stopAgentRun } from './stopChatOperation'
import { sendNativeAgentMessage, stopNativeAgentChat } from './nativeAgentChatSend'
import { useNativeAgentChatStream } from './useNativeAgentChatStream'
import { useNativeRuntimeState } from '@/features/runtimes/useNativeRuntimeState'
import {
  groupEntriesToBlocks,
  MessageList,
  MessageComposer,
  type MessageComposerHandle,
} from './chatComponents'
import { InlineApprovalTray } from '@/features/approvals/InlineApprovalTray'
import { parseTeamOrAgentMention } from '@/lib/parseTeamOrAgentMention'
import { buildBooZeroRulesBlock } from '@/lib/booZeroRules'
import { TeamChips } from './TeamChips'

// A native 1:1 chat has no Gateway 'running' status pushed, so "busy" is an activity
// window: busy while the SSE streams a reply + a short grace after the last frame.
const NATIVE_BUSY_GRACE_MS = 6000

// ─── ChatPanel ────────────────────────────────────────────────────────────────

export function ChatPanel({
  agentId: propAgentId,
  hideHeader = false,
}: { agentId?: string; hideHeader?: boolean } = {}) {
  const storeAgentId = useFleetStore((s) => s.selectedAgentId)
  const resolvedAgentId = propAgentId ?? storeAgentId
  const agents = useFleetStore((s) => s.agents)
  const connectionStatus = useConnectionStore((s) => s.status)
  const client = useConnectionStore((s) => s.client)

  // Sync fleet store selection when agentId is provided as prop
  useEffect(() => {
    if (propAgentId && propAgentId !== useFleetStore.getState().selectedAgentId) {
      useFleetStore.getState().selectAgent(propAgentId)
    }
  }, [propAgentId])

  const agent = agents.find((a) => a.id === resolvedAgentId) ?? null

  const sessionKey = agent?.sessionKey ?? null
  const transcripts = useChatStore((s) => s.transcripts)
  const streamingTextMap = useChatStore((s) => s.streamingText)

  const entries = sessionKey ? (transcripts.get(sessionKey) ?? []) : []
  const streamingText = sessionKey ? (streamingTextMap.get(sessionKey) ?? null) : null

  const blocks = useMemo(() => groupEntriesToBlocks(entries), [entries])

  // ── Load persisted history when an agent is selected and transcript is empty ─
  // Runs whenever sessionKey changes; skips if already in-memory from this session.
  useEffect(() => {
    if (!sessionKey) return
    const existing = useChatStore.getState().transcripts.get(sessionKey)
    if (existing && existing.length > 0) return

    fetch(`/api/chat-history?sessionKey=${encodeURIComponent(sessionKey)}`)
      .then((r) => r.json())
      .then(({ entries: historical }: { entries?: TranscriptEntry[] }) => {
        if (historical && historical.length > 0) {
          useChatStore.getState().appendTranscript(sessionKey, historical)
        }
      })
      .catch(() => {})
  }, [sessionKey])

  // ── Native 1:1 chat (the Boo-Zero personal chat + any clawboo-native agent) ──
  // A native agent is NOT an OpenClaw Gateway agent, so its 1:1 chat is driven
  // server-side (POST /api/agents/:id/chat) + streamed back over SSE, NOT via
  // `client.chat.send` (which errors "agent no longer exists in configuration").
  const isNativeChat = agent?.runtime === 'clawboo-native'
  // Busy signal for the native chat (no Gateway 'running' status): busy while SSE
  // frames stream + a grace, refreshed on every frame + on send.
  const [nativeBusy, setNativeBusy] = useState(false)
  const nativeActivityRef = useRef(0)
  const bumpNativeActivity = useCallback(() => {
    nativeActivityRef.current = Date.now()
    setNativeBusy(true)
  }, [])
  useEffect(() => {
    if (!nativeBusy) return
    const id = setInterval(() => {
      if (Date.now() - nativeActivityRef.current > NATIVE_BUSY_GRACE_MS) setNativeBusy(false)
    }, 1000)
    return () => clearInterval(id)
  }, [nativeBusy])
  // Feed the native chat's SSE (committed turns + live token deltas) into the store.
  // Inert for a non-native agent (enabled=false) — the Gateway path is unchanged.
  useNativeAgentChatStream({
    agentId: agent?.id ?? '',
    enabled: isNativeChat && Boolean(agent),
    onActivity: bumpNativeActivity,
  })

  const isRunning = isNativeChat ? nativeBusy : agent?.status === 'running'
  // Truthful native credential state: 'needs-auth' = the runtime has NO provider
  // key, so a send cannot possibly succeed — gate the composer + badge on it
  // instead of showing green "Connected" over a silent non-responder. Fail-safe:
  // null (probe pending/failed) never degrades the UI.
  const nativeState = useNativeRuntimeState(isNativeChat)
  const nativeKeyless = isNativeChat && nativeState === 'needs-auth'
  // A native chat needs NO Gateway client; an OpenClaw chat does.
  const canSend = Boolean(
    (isNativeChat || client) &&
    connectionStatus === 'connected' &&
    agent &&
    sessionKey &&
    !isRunning &&
    !nativeKeyless,
  )

  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const teams = useTeamStore((s) => s.teams)
  const isBooZeroChat = Boolean(agent && booZeroAgentId && agent.id === booZeroAgentId)

  // Composer ref — lets the TeamChips row insert `@TeamName` at the start of
  // the draft when the user clicks a chip. Only used in Boo Zero's chat (the
  // place where team mentions are meaningful).
  const composerRef = useRef<MessageComposerHandle>(null)

  // Active teams (un-archived) surfaced as chips above the composer in Boo
  // Zero's individual chat. Clicking a chip prepends `@<TeamName>` to the
  // draft — the same `parseTeamOrAgentMention` path in `handleSend` then
  // pulls the team's brief into the message preamble.
  const activeTeams = useMemo(() => teams.filter((t) => !t.isArchived), [teams])
  // The composer's autocomplete dropdown reads `mentionAgents`. We feed it
  // the team list (mapping `{id, name}`) so typing `@D…` opens a filtered
  // dropdown of matching team names. Treating teams as the "mention agent"
  // source here is intentional: Boo Zero's individual chat doesn't have
  // a team-agent roster, so the only meaningful @-targets are teams.
  const mentionTargets = useMemo(
    () =>
      isBooZeroChat
        ? activeTeams.map((t) => ({
            id: t.id,
            name: t.name,
            // Pass the team's emoji + color so the dropdown renders the same
            // emoji-disc as the `TeamChips` row instead of a random Boo avatar
            // seeded from the team's UUID.
            icon: t.icon,
            color: t.color,
          }))
        : [],
    [isBooZeroChat, activeTeams],
  )
  const handleChipTag = useCallback((name: string) => {
    composerRef.current?.insertMention(name)
  }, [])

  const handleSend = useCallback(
    async (message: string) => {
      if (!agent || !sessionKey) return
      // A native chat drives the run server-side (no Gateway client); an OpenClaw
      // chat requires a live client.
      if (!isNativeChat && !client) return

      // Native `/reset` — clear the local + persisted 1:1 history (there is no
      // Gateway session to recreate). The Gateway path handles `/reset` inside
      // `sendChatMessage` (sessions.create).
      const trimmed = message.trim()
      if (isNativeChat && (trimmed === '/reset' || trimmed === '/new')) {
        useChatStore.getState().clearTranscript(sessionKey)
        void fetch(`/api/chat-history?sessionKey=${encodeURIComponent(sessionKey)}`, {
          method: 'DELETE',
        }).catch(() => {})
        return
      }

      // Transport: native agents run server-side + stream over SSE; OpenClaw agents
      // ride the Gateway. `outbound` is the (context-injected) text delivered to the
      // model; `display` is what shows in the transcript (undefined = same as outbound).
      const deliver = async (outbound: string, display: string | undefined): Promise<void> => {
        if (isNativeChat) {
          bumpNativeActivity()
          await sendNativeAgentMessage({
            agentId: agent.id,
            sessionKey,
            message: outbound,
            displayText: display ?? outbound,
          })
        } else if (client) {
          await sendChatMessage({
            client,
            agentId: agent.id,
            sessionKey,
            message: outbound,
            ...(display ? { displayText: display } : {}),
          })
        }
      }

      // In Boo Zero's individual chat, inject the rules block + (when the
      // user `@TeamName`-mentions) the matching team brief. The rules block
      // carries identity + load-bearing behavioral rules (delegate first,
      // don't do work yourself, no Task tool, no resume greetings) and
      // fires on EVERY message so the LLM stays consistent. Outside Boo
      // Zero's chat (regular agent 1:1), this path is bypassed — team
      // agents have their own AGENTS.md / SOUL.md identity.
      if (isBooZeroChat) {
        // No teamName in the 1:1 chat path — Boo Zero coordinates across
        // every team here, not within any single team's scope.
        const identityBlock = buildBooZeroRulesBlock({ displayName: agent.name })

        const teamCandidates = teams.map((t) => ({ id: t.id, name: t.name }))
        const mention = parseTeamOrAgentMention(message, teamCandidates)

        if (mention.kind === 'team' && mention.targetId) {
          // Pull the team's REAL recent activity from the SERVER on demand: its
          // Boo-Zero brief + board state + recent team chat, composed + capped
          // server-side (`buildTeamActivitySummary`). This works regardless of what
          // THIS browser session has loaded — Boo Zero's individual chat is a
          // separate session from the team's group chat, and the server reads the
          // durable `chat_messages` + board rows directly (the old path read only
          // client-store transcripts, empty unless the group chat was opened).
          // Best-effort: a miss injects nothing.
          let activityBlock: string | null = null
          try {
            const res = await fetch(
              `/api/teams/${encodeURIComponent(mention.targetId)}/activity-summary`,
            )
            if (res.ok) {
              const body = (await res.json()) as { content?: string | null }
              if (typeof body.content === 'string' && body.content.trim()) {
                activityBlock = body.content.trim()
              }
            }
          } catch {
            // Best-effort — missing activity is silently OK.
          }

          // Order: identity (who you are) → the team's activity → the user's question.
          const sections = [identityBlock, activityBlock, mention.cleanedMessage].filter(
            (s): s is string => Boolean(s),
          )
          await deliver(sections.join('\n\n'), message)
          return
        }

        // No team mention — still inject the identity anchor on every Boo
        // Zero turn.
        await deliver(`${identityBlock}\n\n${message}`, message)
        return
      }

      await deliver(message, undefined)
    },
    [client, agent, sessionKey, isBooZeroChat, isNativeChat, teams, bumpNativeActivity],
  )

  // ── No agent selected ───────────────────────────────────────────────────────
  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="font-mono text-[12px] text-foreground/45">
          Select an agent from the fleet sidebar.
        </p>
      </div>
    )
  }

  // ── Chat view ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col" data-testid="chat-panel">
      {/* Header — skipped when the parent provides a shared header above us
          (e.g. `AgentDetailView` extends the agent identity row across all
          three panels, so this panel's own header would duplicate it). */}
      {!hideHeader && (
        <div className="flex min-h-[52px] items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <AgentBooAvatar agentId={agent.id} size={30} />
            <h2
              className="truncate font-display text-[15px] font-bold text-foreground"
              style={{ letterSpacing: '-0.01em' }}
            >
              {agent.name}
            </h2>
            {!sessionKey && (
              <span className="shrink-0 rounded-full bg-amber/15 px-2 py-0.5 font-mono text-[10px] font-medium text-amber">
                No session
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${nativeKeyless ? 'bg-amber/80' : connectionStatus === 'connected' ? 'bg-mint' : 'bg-foreground/25'}`}
              aria-hidden
            />
            <span
              className={`font-mono text-[10px] uppercase tracking-[0.1em] ${nativeKeyless ? 'text-amber/90' : 'text-foreground/45'}`}
            >
              {nativeKeyless
                ? 'Disconnected'
                : connectionStatus === 'connected'
                  ? 'Connected'
                  : connectionStatus}
            </span>
            {nativeKeyless && (
              <button
                type="button"
                data-testid="native-disconnected-chip"
                onClick={() => useSettingsModalStore.getState().openSettings('runtimes')}
                className="cursor-pointer rounded-full border border-amber/25 bg-amber/10 px-2 py-0.5 text-[10px] font-medium text-amber transition-colors hover:bg-amber/20"
              >
                Set up in Runtimes →
              </button>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <MessageList
        blocks={blocks}
        streamingText={streamingText}
        agentId={agent.id}
        agentName={agent.name}
        isRunning={isRunning}
      />

      {/* Inline approval cards for this agent */}
      <InlineApprovalTray agentId={agent.id} />

      {/* Team chips — Boo Zero's individual chat only. Lets the user tag any
          team with @TeamName so Boo Zero pulls that team's brief into context
          for this turn. Hidden in regular 1:1 agent chats (team tagging is
          meaningless there). */}
      {isBooZeroChat && activeTeams.length > 0 && (
        <TeamChips teams={activeTeams} onTag={handleChipTag} />
      )}

      {/* Composer */}
      <MessageComposer
        ref={composerRef}
        onSend={handleSend}
        disabled={!canSend}
        // Pass the team list as mentionAgents so the in-composer autocomplete
        // dropdown opens on `@` and filters as the user types. Empty array
        // outside Boo Zero's chat → no autocomplete (regular 1:1 behavior).
        mentionAgents={mentionTargets}
        // Stop button — replaces Send while the agent is running. Native chats
        // abort the server-side run (`/chat/stop`); OpenClaw chats pull the plug on
        // the in-flight LLM call via `chat.abort`. Both optimistically clear local
        // streaming state so the UI flips to idle within one render.
        isActive={isRunning}
        onStop={() => {
          if (isNativeChat) {
            void stopNativeAgentChat(agent.id)
          } else {
            void stopAgentRun({
              client,
              agentId: agent.id,
              sessionKey,
              runId: agent.runId,
            })
          }
        }}
        placeholder={
          nativeKeyless
            ? 'Clawboo Native is disconnected — set it up in Settings → Runtimes…'
            : !isNativeChat && !client
              ? 'Gateway not connected…'
              : !sessionKey
                ? 'No active session…'
                : isRunning
                  ? isNativeChat
                    ? 'Thinking…'
                    : 'Agent is working…'
                  : isBooZeroChat
                    ? 'Ask me anything… use @ to tag a team'
                    : 'Message…'
        }
      />
    </div>
  )
}
