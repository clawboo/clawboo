import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useBooZeroStore } from '@/stores/booZero'
import { useTeamStore } from '@/stores/team'
import { sendChatMessage } from './chatSendOperation'
import { stopAgentRun } from './stopChatOperation'
import {
  groupEntriesToBlocks,
  MessageList,
  MessageComposer,
  type MessageComposerHandle,
} from './chatComponents'
import { InlineApprovalTray } from '@/features/approvals/InlineApprovalTray'
import { parseTeamOrAgentMention } from '@/lib/parseTeamOrAgentMention'
import { buildTeamContextPreamble } from '@/lib/teamProtocol'
import { getMergedTeamEntries } from '@/features/group-chat/groupChatSendOperation'
import { TeamChips } from './TeamChips'

// ─── ChatPanel ────────────────────────────────────────────────────────────────

export function ChatPanel({ agentId: propAgentId }: { agentId?: string } = {}) {
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

  const isRunning = agent?.status === 'running'
  const canSend = Boolean(
    client && connectionStatus === 'connected' && agent && sessionKey && !isRunning,
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
      if (!client || !agent || !sessionKey) return

      // In Boo Zero's individual chat, inject the identity anchor + (when
      // the user `@TeamName`-mentions) the matching team brief. The
      // identity anchor fires on EVERY message so the LLM stays consistent
      // about its name. Outside Boo Zero's chat (regular agent 1:1), this
      // path is bypassed — team agents have their own AGENTS.md / SOUL.md
      // identity.
      if (isBooZeroChat) {
        const identityBlock = `[Your Identity]\nYou are ${agent.name}. This is your name — the only name you should use to refer to yourself. Do NOT invent alternative names mid-response.\n[End Your Identity]`

        const teamCandidates = teams.map((t) => ({ id: t.id, name: t.name }))
        const mention = parseTeamOrAgentMention(message, teamCandidates)

        if (mention.kind === 'team' && mention.targetId) {
          let briefBlock: string | null = null
          try {
            const res = await fetch(
              `/api/boo-zero/team-briefs/${encodeURIComponent(mention.targetId)}`,
            )
            if (res.ok) {
              const body = (await res.json()) as { content?: string | null }
              if (typeof body.content === 'string' && body.content.length > 0) {
                briefBlock = `[Team Brief: ${mention.matchedName}]\n${body.content.trim()}\n[End Team Brief]`
              }
            }
          } catch {
            // Best-effort — missing brief is silently OK.
          }

          // Inject recent team-chat history. The user's individual chat with
          // Boo Zero is a separate session from the team's group chat — Boo
          // Zero literally has no record of what the team was doing without
          // this. We reuse the same merge + preamble helpers the group chat
          // uses, with their built-in token caps:
          //   - last 10 messages from the team's transcripts
          //   - 1500 char hard cap (drops oldest lines until it fits)
          //
          // The merge pulls from each team agent's team-scoped sessionKey
          // (`agent:<memberId>:team:<teamId>`) AND Boo Zero's team-scoped
          // sessionKey (so Boo Zero's own prior team-chat participation is
          // included). Boo Zero's individual-chat history isn't pulled in —
          // that's already in the LLM's context window from this session.
          //
          // Token cost: typically 300–1500 tokens per @team turn, same order
          // of magnitude as the group chat's own preamble. If the team has
          // no transcripts (e.g. team deployed but never chatted) the helper
          // returns null and we don't inject anything.
          const allAgents = useFleetStore.getState().agents
          const teamMembers = allAgents.filter((a) => a.teamId === mention.targetId)
          const teamEntries = getMergedTeamEntries(mention.targetId, teamMembers, agent)
          const historyBlock = buildTeamContextPreamble({
            entries: teamEntries,
            // Pass empty target so no entries are filtered out — we want
            // every speaker's voice in the context.
            targetAgentName: '',
            maxMessages: 10,
            maxChars: 1500,
          })

          // Order matters: identity (who you are) → team brief (who the team
          // is) → recent team history (what they've been doing) → user's
          // actual question.
          const sections = [identityBlock, briefBlock, historyBlock, mention.cleanedMessage].filter(
            (s): s is string => Boolean(s),
          )
          await sendChatMessage({
            client,
            agentId: agent.id,
            sessionKey,
            message: sections.join('\n\n'),
            displayText: message,
          })
          return
        }

        // No team mention — still inject the identity anchor on every Boo
        // Zero turn.
        await sendChatMessage({
          client,
          agentId: agent.id,
          sessionKey,
          message: `${identityBlock}\n\n${message}`,
          displayText: message,
        })
        return
      }

      await sendChatMessage({ client, agentId: agent.id, sessionKey, message })
    },
    [client, agent, sessionKey, isBooZeroChat, teams],
  )

  // ── No agent selected ───────────────────────────────────────────────────────
  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="font-mono text-[12px] text-secondary/50">
          Select an agent from the fleet sidebar.
        </p>
      </div>
    )
  }

  // ── Chat view ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col" data-testid="chat-panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <AgentBooAvatar agentId={agent.id} size={30} />
          <h2
            className="text-[14px] font-semibold text-text"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {agent.name}
          </h2>
          {!sessionKey && <span className="font-mono text-[10px] text-amber/60">No session</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-secondary/40">
            {connectionStatus === 'connected' ? 'Connected' : connectionStatus}
          </span>
        </div>
      </div>

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
        // Stop button — replaces Send while the agent is running. Pulls the
        // plug on the in-flight LLM call via `chat.abort` AND optimistically
        // clears local streaming state so the UI flips to idle within one
        // render even if the RPC round-trips slowly. See `stopChatOperation`.
        isActive={isRunning}
        onStop={() => {
          void stopAgentRun({
            client,
            agentId: agent.id,
            sessionKey,
            runId: agent.runId,
          })
        }}
        placeholder={
          !client
            ? 'Gateway not connected…'
            : !sessionKey
              ? 'No active session…'
              : isRunning
                ? 'Agent is working…'
                : isBooZeroChat
                  ? 'Ask me anything… use @ to tag a team'
                  : 'Message…'
        }
      />
    </div>
  )
}
