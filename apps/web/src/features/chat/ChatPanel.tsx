import { useCallback, useEffect, useMemo } from 'react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useBooZeroStore } from '@/stores/booZero'
import { useTeamStore } from '@/stores/team'
import { sendChatMessage } from './chatSendOperation'
import { groupEntriesToBlocks, MessageList, MessageComposer } from './chatComponents'
import { InlineApprovalTray } from '@/features/approvals/InlineApprovalTray'
import { parseTeamOrAgentMention } from '@/lib/parseTeamOrAgentMention'

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

  const handleSend = useCallback(
    async (message: string) => {
      if (!client || !agent || !sessionKey) return

      // In Boo Zero's individual chat, parse `@TeamName` mentions and inject
      // that team's brief into the message preamble so Boo Zero can reason
      // about the team's specifics. Outside of Boo Zero's chat (regular
      // agent 1:1), this code path is bypassed entirely.
      if (isBooZeroChat) {
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
          // Keep the user-visible message (with the @TeamName prefix) as the
          // display text; send Boo Zero the brief + the user's intent.
          const sendBody = briefBlock
            ? `${briefBlock}\n\n${mention.cleanedMessage}`
            : mention.cleanedMessage
          await sendChatMessage({
            client,
            agentId: agent.id,
            sessionKey,
            message: sendBody,
            displayText: message,
          })
          return
        }
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

      {/* Composer */}
      <MessageComposer
        onSend={handleSend}
        disabled={!canSend}
        placeholder={
          !client
            ? 'Gateway not connected…'
            : !sessionKey
              ? 'No active session…'
              : isRunning
                ? 'Agent is working…'
                : 'Message…'
        }
      />
    </div>
  )
}
