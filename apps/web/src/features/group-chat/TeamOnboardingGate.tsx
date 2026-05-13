// TeamOnboardingGate — three-phase onboarding flow that gates the normal team
// chat composer. Replaces the old auto-wake-on-first-message flow that caused
// the message-flooding cascade (wake → intros with @mentions → false delegations
// → relay → more intros).
//
// Phase A: "Know Your Team" button — agents not yet introduced
// Phase B: Sequential agent introductions — one chat.send per agent, no @mentions
// Phase C: User self-introduction — saved to each agent's SOUL.md
//
// During onboarding, useTeamOrchestration is NOT mounted (GroupChatPanel
// doesn't render until onComplete fires), so delegation detection and relay
// are inactive — this is what prevents the cascade.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Send, ArrowRight, Check } from 'lucide-react'
import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { TranscriptEntry } from '@clawboo/protocol'
import { BooAvatar } from '@clawboo/ui'
import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useToastStore } from '@/stores/toast'
import { buildTeamSessionKey, setTeamChatOverride } from '@/lib/sessionUtils'
import { markAgentAwake } from '@/lib/wakeTracker'
import { nextSeq } from '@/lib/sequenceKey'
import { syncBooZeroSoulIdentity } from '@/lib/booZeroIdentitySync'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamOnboardingGateProps {
  teamId: string
  team: Team | null
  teamAgents: AgentState[]
  /**
   * Boo Zero — the universal team leader. When present, the welcome card
   * shows a "Led by <BooZero Name>" badge so the user knows Boo Zero will
   * be the team's first responder. Boo Zero does NOT participate in the
   * Phase B intro cascade (it's teamless, so already excluded from
   * `teamAgents`), avoiding any contribution to the message-flooding
   * cascade the gate was originally introduced to prevent.
   */
  booZeroAgent?: AgentState | null
  client: GatewayClientLike | null
  agentsIntroduced: boolean
  userIntroduced: boolean
  onMarkAgentsIntroduced: () => Promise<void>
  onMarkUserIntroduced: (introText: string) => Promise<void>
}

type Phase = 'welcome' | 'introducing' | 'user-intro'

// ─── Prompt builders (no @mentions, no teammate list) ────────────────────────

const AGENT_INTRO_PROMPT = [
  'You are joining a team collaboration session.',
  '',
  'Please introduce yourself in EXACTLY one or two sentences:',
  '- Your name',
  '- What you specialize in',
  '',
  'Keep it brief and friendly. Do NOT mention or tag any teammates.',
  'Do NOT use @ in your response.',
].join('\n')

/**
 * Stronger retry prompt — used when an agent's first intro is refusal-
 * shaped or too short to convey identity ("NO" was the smoking gun from
 * production). The retry is explicit that this is a routine introduction
 * and asks for a longer response than the first prompt.
 */
const AGENT_INTRO_RETRY_PROMPT = [
  'Your previous response was unclear and could not be used as a team introduction.',
  '',
  'Please introduce yourself properly in two sentences:',
  '- Your name (as set in your IDENTITY.md)',
  '- What you specialize in / what teammates can come to you for',
  '',
  'This is a ROUTINE team introduction — not a task assignment, not a sensitive request, not anything to refuse. Every member of this team is doing the same now.',
  '',
  'Do NOT respond with refusals, "NO", or other short non-answers. Do NOT mention teammates by name. Aim for ~30-80 words.',
].join('\n')

const MIN_INTRO_CHARS = 25
const REFUSAL_RE = /^(no|nope|sorry|can'?t|cannot|unable)\b/i

function isValidIntro(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < MIN_INTRO_CHARS) return false
  if (REFUSAL_RE.test(trimmed)) return false
  return true
}

function buildUserIntroSoulPatch(userIntro: string): string {
  return `\n\n## About the User\n${userIntro.trim()}\n`
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TeamOnboardingGate({
  teamId,
  team,
  teamAgents,
  booZeroAgent,
  client,
  agentsIntroduced,
  userIntroduced: _userIntroduced,
  onMarkAgentsIntroduced,
  onMarkUserIntroduced,
}: TeamOnboardingGateProps) {
  // Determine starting phase from server-persisted state
  const initialPhase: Phase = agentsIntroduced ? 'user-intro' : 'welcome'
  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [introducingAgentIds, setIntroducingAgentIds] = useState<Set<string>>(new Set())
  const [completedAgentIds, setCompletedAgentIds] = useState<Set<string>>(new Set())
  const [userIntroText, setUserIntroText] = useState<string>('')
  const [submittingUserIntro, setSubmittingUserIntro] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef<boolean>(false)

  // Snapshot transcript counts at the moment we kick off agent intros so we
  // can detect "this agent has produced a NEW response since we asked them".
  const baselineCountsRef = useRef<Map<string, number>>(new Map())

  // Per-agent retry count — capped at 1 so we don't loop on a stubbornly
  // refusing model. When an intro is refusal-shaped or too short, we fire
  // the retry prompt once with a stronger ask before accepting whatever
  // the agent eventually produces.
  const retriesRef = useRef<Map<string, number>>(new Map())

  // ── Phase B: detect agent intro completion via transcript subscription ──
  useEffect(() => {
    if (phase !== 'introducing') return

    const handleStoreChange = () => {
      const transcripts = useChatStore.getState().transcripts
      let changed = false
      const nextCompleted = new Set(completedAgentIds)
      for (const agent of teamAgents) {
        if (nextCompleted.has(agent.id)) continue
        const teamSk = buildTeamSessionKey(agent.id, teamId)
        const entries = transcripts.get(teamSk) ?? []
        const baseline = baselineCountsRef.current.get(agent.id) ?? 0
        // Look for a NEW assistant entry since we sent the intro prompt.
        const newAssistant = entries
          .slice(baseline)
          .find((e) => e.role === 'assistant' && e.kind === 'assistant' && e.text.trim().length > 0)
        if (!newAssistant) continue

        // Validate the intro response. If it's refusal-shaped or too
        // short, retry ONCE with a stronger prompt. After the cap (1
        // retry), accept whatever lands — better to move on than to
        // loop forever on a stubbornly-refusing model. Smoking gun from
        // production: "NO" from Jira Workflow Steward Boo.
        if (isValidIntro(newAssistant.text)) {
          nextCompleted.add(agent.id)
          changed = true
          continue
        }

        const retries = retriesRef.current.get(agent.id) ?? 0
        if (retries >= 1) {
          // Already retried; accept this response as-is so onboarding
          // can advance.
          nextCompleted.add(agent.id)
          changed = true
          continue
        }
        if (!client) {
          // No client to fire the retry — accept what we have.
          nextCompleted.add(agent.id)
          changed = true
          continue
        }
        retriesRef.current.set(agent.id, retries + 1)
        // Bump the baseline so the NEXT response (post-retry-prompt) is
        // what we detect as new, not the current weak one.
        baselineCountsRef.current.set(agent.id, entries.length)
        // Fire the retry prompt — best-effort. The override is already
        // set from the initial send; no need to re-set it.
        void client
          .call('chat.send', {
            sessionKey: teamSk,
            message: AGENT_INTRO_RETRY_PROMPT,
            deliver: false,
            idempotencyKey: crypto.randomUUID(),
          })
          .catch(() => {
            // Retry send failed — accept whatever we already have so
            // the user isn't stuck on the gate forever.
            nextCompleted.add(agent.id)
            setCompletedAgentIds((prev) => {
              const merged = new Set(prev)
              merged.add(agent.id)
              return merged
            })
          })
      }
      if (changed) setCompletedAgentIds(nextCompleted)
    }

    handleStoreChange()
    const unsub = useChatStore.subscribe(handleStoreChange)
    return () => {
      unsub()
    }
  }, [phase, teamAgents, teamId, completedAgentIds, client])

  // When all agents finish introducing, advance to user-intro phase AND
  // post a single meta entry "introducing" Boo Zero as the team's universal
  // leader. We do this client-side (no Gateway round-trip) so the entry is
  // free of any cascade risk and the user gets immediate feedback.
  useEffect(() => {
    if (phase !== 'introducing') return
    if (teamAgents.length === 0) return
    if (completedAgentIds.size < teamAgents.length) return
    void (async () => {
      // Boo Zero "introducing itself" — meta entry into Boo Zero's team-scoped
      // session so the merged transcript shows the universal-leader voice
      // first when the user lands in normal chat.
      if (booZeroAgent && team) {
        const booTeamSk = buildTeamSessionKey(booZeroAgent.id, teamId)
        const introEntry: TranscriptEntry = {
          entryId: crypto.randomUUID(),
          runId: null,
          sessionKey: booTeamSk,
          kind: 'assistant',
          role: 'assistant',
          text: `Hi — I'm ${booZeroAgent.name}, your universal team leader for ${team.name}. I'll triage your messages, delegate to the right teammate, and synthesize their work back to you.`,
          source: 'local-send',
          timestampMs: Date.now(),
          sequenceKey: nextSeq(),
          confirmed: true,
          fingerprint: crypto.randomUUID(),
        }
        useChatStore.getState().appendTranscript(booTeamSk, [introEntry])
      }
      await onMarkAgentsIntroduced()
      setPhase('user-intro')
    })()
  }, [
    phase,
    teamAgents.length,
    completedAgentIds,
    onMarkAgentsIntroduced,
    booZeroAgent,
    team,
    teamId,
  ])

  // ── Phase A action: Know Your Team button ─────────────────────────────────
  const handleStartIntros = useCallback(async () => {
    if (!client || teamAgents.length === 0) return
    if (startedRef.current) return
    startedRef.current = true

    setError(null)
    setPhase('introducing')

    // Snapshot transcript counts BEFORE sending so we detect new responses
    const transcripts = useChatStore.getState().transcripts
    for (const agent of teamAgents) {
      const teamSk = buildTeamSessionKey(agent.id, teamId)
      baselineCountsRef.current.set(agent.id, transcripts.get(teamSk)?.length ?? 0)
    }

    // Mark all agents as currently being introduced (UI state)
    setIntroducingAgentIds(new Set(teamAgents.map((a) => a.id)))

    // Send intro prompt to each agent SEQUENTIALLY (not in parallel) to keep
    // the UI ordered and prevent thundering-herd Gateway load. Each call is
    // best-effort; one failure doesn't block the others.
    for (const agent of teamAgents) {
      const teamSk = buildTeamSessionKey(agent.id, teamId)
      // Set override so Gateway events (which use main sessionKey) get
      // redirected to the team session.
      setTeamChatOverride(agent.id, teamSk)
      try {
        await client.call('chat.send', {
          sessionKey: teamSk,
          message: AGENT_INTRO_PROMPT,
          deliver: false,
          idempotencyKey: crypto.randomUUID(),
        })
        markAgentAwake(agent.id, teamId)
      } catch {
        // Non-fatal — surface a soft error and continue
      }
    }
  }, [client, teamAgents, teamId])

  // ── Phase C action: submit user introduction ──────────────────────────────
  const handleSubmitUserIntro = useCallback(async () => {
    if (!client) return
    const trimmed = userIntroText.trim()
    if (trimmed.length < 5) {
      setError('Please write a short introduction (at least 5 characters).')
      return
    }
    setError(null)
    setSubmittingUserIntro(true)

    const patchBlock = buildUserIntroSoulPatch(trimmed)

    // Append to each agent's SOUL.md (idempotent: only if "## About the User"
    // is not already present). Best-effort per agent.
    //
    // IMPORTANT: Gateway RPC params are `name`, NOT `path` (see
    // `packages/gateway-client/src/client.ts:485,495`). Earlier code used
    // `path:`, which the Gateway silently dropped — writes never landed.
    //
    // ALSO: per CLAUDE.md, `agents.files.set('SOUL.md')` is known to be
    // unreliable for persistence. We treat the SOUL.md write as best-effort
    // and rely on the SQLite-backed user-intro persistence + context preamble
    // injection (handled by markUserIntroduced + groupChatSendOperation) as
    // the actual source of truth.
    const writePromises = teamAgents.map(async (agent) => {
      try {
        let current = ''
        try {
          const res = await client.call<{ file: { content?: string; missing?: boolean } }>(
            'agents.files.get',
            { agentId: agent.id, name: 'SOUL.md' },
          )
          current = res?.file?.content ?? ''
        } catch {
          current = ''
        }
        let next: string
        if (current.includes('## About the User')) {
          // Replace the existing block to keep it current.
          next = current.replace(/\n*## About the User[\s\S]*?(\n## |$)/, (_match, p1) => {
            return `${patchBlock}${p1 === '\n## ' ? '\n## ' : ''}`
          })
        } else {
          next = `${current.trimEnd()}${patchBlock}`
        }
        await client.call('agents.files.set', {
          agentId: agent.id,
          name: 'SOUL.md',
          content: next,
        })
      } catch {
        // Non-fatal — one agent failing doesn't block the gate from opening.
      }
    })
    await Promise.allSettled(writePromises)

    // Boo Zero SOUL.md sync — submitting the user intro is the per-team
    // onboarding "approval moment". The user has just told us they're ready
    // to chat with this team, which is the right moment to also re-anchor
    // Boo Zero's persisted identity with the current display name. Best-
    // effort; the per-turn rules block stays authoritative regardless.
    if (booZeroAgent) {
      void syncBooZeroSoulIdentity({
        client,
        agentId: booZeroAgent.id,
        displayName: booZeroAgent.name,
      })
    }

    // Drop a meta entry into each agent's team transcript so the user sees
    // their introduction land in chat (the agents won't respond to it — it
    // was only written to SOUL.md, not sent as a chat message).
    const now = Date.now()
    for (const agent of teamAgents) {
      const teamSk = buildTeamSessionKey(agent.id, teamId)
      const entry: TranscriptEntry = {
        entryId: crypto.randomUUID(),
        runId: null,
        sessionKey: teamSk,
        kind: 'meta',
        role: 'system',
        text: `User introduction saved to ${agent.name}'s context.`,
        source: 'local-send',
        timestampMs: now,
        // Strictly-increasing tiebreaker (see lib/sequenceKey.ts).
        sequenceKey: nextSeq(),
        confirmed: true,
        fingerprint: crypto.randomUUID(),
      }
      useChatStore.getState().appendTranscript(teamSk, [entry])
    }

    try {
      // Persist user intro to SQLite — this is the SOURCE OF TRUTH. Even if the
      // SOUL.md writes above silently fail (Gateway is unreliable for this
      // file), the intro is preserved here and gets injected into the team
      // context preamble on every group-chat message via groupChatSendOperation,
      // guaranteeing the agent always sees it.
      await onMarkUserIntroduced(trimmed)
      useToastStore.getState().addToast({
        message: 'Welcome aboard! Your team is ready.',
        type: 'success',
      })
    } catch {
      // The PATCH failed — show error but don't lock the user out
      setError('Could not save onboarding state. You may need to do this again.')
    } finally {
      setSubmittingUserIntro(false)
    }
  }, [client, userIntroText, teamAgents, teamId, booZeroAgent, onMarkUserIntroduced])

  // ── Read agent intro responses to display in Phase C ──────────────────────
  // Use the LAST assistant entry after the per-agent baseline so the recap
  // shows the agent's actual introduction even when an earlier attempt was
  // refusal-shaped and we retried. Before this fix, a "NO" intro from agent X
  // would stay visible in the recap even after the retry produced a clean
  // intro — `entries.find(...)` returned the first match, ignoring the retry.
  const agentIntros = useMemo(() => {
    const transcripts = useChatStore.getState().transcripts
    const intros = new Map<string, string>()
    for (const agent of teamAgents) {
      const teamSk = buildTeamSessionKey(agent.id, teamId)
      const entries = transcripts.get(teamSk) ?? []
      const baseline = baselineCountsRef.current.get(agent.id) ?? 0
      // Walk backwards so we get the LATEST assistant entry post-baseline.
      // (If the retry produced a longer/cleaner reply, that's the one to
      // display; the refusal-shaped first attempt stays in chat history but
      // the recap shows what the user can actually act on.)
      let latest: string | null = null
      for (let i = entries.length - 1; i >= baseline; i--) {
        const e = entries[i]
        if (e && e.role === 'assistant' && e.kind === 'assistant' && e.text.trim().length > 0) {
          latest = e.text.trim()
          break
        }
      }
      // Fallback: if we didn't find anything post-baseline (shouldn't happen
      // once the gate has detected completion), use the first overall.
      if (!latest) {
        const found = entries.find(
          (e) => e.role === 'assistant' && e.kind === 'assistant' && e.text.trim().length > 0,
        )
        if (found) latest = found.text.trim()
      }
      if (latest) intros.set(agent.id, latest)
    }
    return intros
    // We re-derive whenever completedAgentIds changes (Phase B updates) or the
    // user advances to Phase C. Reading the chat store directly keeps it fresh.
  }, [teamAgents, teamId, completedAgentIds, phase])

  // ── Render ─────────────────────────────────────────────────────────────────
  // No local header — `GroupChatViewHeader` (rendered by `GroupChatView`
  // above the graph + chat split) already shows the team identity. Adding a
  // second header here would duplicate the team name + agent count one line
  // below the unified header.
  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-8">
        <AnimatePresence mode="wait">
          {phase === 'welcome' && (
            <motion.div
              key="welcome"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="mx-auto flex max-w-md flex-col items-center text-center"
            >
              {/* The universal team leader (Boo Zero) introduces the team —
                  its avatar replaces the abstract sparkle icon for a stronger
                  "leader presenting the team" framing. Falls back to the
                  sparkle in a colored ring when Boo Zero hasn't been
                  identified (rare — should only happen in the brief window
                  before `identifyBooZero` lands after first hydrate). */}
              {booZeroAgent ? (
                <div className="mb-4">
                  <BooAvatar seed={booZeroAgent.id} size={56} isBooZero />
                </div>
              ) : (
                <div
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-full"
                  style={{ background: `${team?.color ?? '#34D399'}22` }}
                >
                  <Sparkles size={22} style={{ color: team?.color ?? '#34D399' }} />
                </div>
              )}
              <h3
                className="mb-2 text-[18px] font-semibold text-text"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Meet your team
              </h3>
              <p className="mb-6 text-[12px] leading-relaxed text-secondary">
                Before you start chatting, get to know your {teamAgents.length} agent
                {teamAgents.length !== 1 ? 's' : ''}. They&rsquo;ll briefly introduce themselves so
                you know who does what.
              </p>

              {/* Agent avatars */}
              <div className="mb-4 flex flex-wrap items-center justify-center gap-3">
                {teamAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex flex-col items-center gap-1.5"
                    style={{ minWidth: 64 }}
                  >
                    <BooAvatar seed={agent.id} size={40} />
                    <span className="max-w-[80px] truncate text-[10px] text-secondary/70">
                      {agent.name}
                    </span>
                  </div>
                ))}
              </div>

              {/* "Led by Boo Zero" badge — Boo Zero is the universal team
                  leader and will respond first in every team chat, even
                  though it doesn't appear in the team's sidebar agent list. */}
              {booZeroAgent && (
                <div
                  className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/8 bg-surface/60 px-3 py-1.5 text-[11px] text-secondary"
                  data-testid="led-by-boo-zero-badge"
                >
                  <BooAvatar seed={booZeroAgent.id} size={20} />
                  <span>
                    Led by <strong className="text-text">{booZeroAgent.name}</strong> — your
                    universal team leader
                  </span>
                </div>
              )}

              <button
                type="button"
                onClick={handleStartIntros}
                disabled={!client || teamAgents.length === 0}
                className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-[13px] font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: '#E94560', color: '#fff' }}
                data-testid="know-your-team-button"
              >
                Know Your Team
                <ArrowRight size={14} />
              </button>
            </motion.div>
          )}

          {phase === 'introducing' && (
            <motion.div
              key="introducing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="mx-auto flex max-w-md flex-col"
            >
              <h3
                className="mb-2 text-center text-[16px] font-semibold text-text"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Agents are introducing themselves
              </h3>
              <p className="mb-6 text-center text-[12px] text-secondary">
                {completedAgentIds.size} of {teamAgents.length} done
              </p>

              <div className="flex flex-col gap-3">
                {teamAgents.map((agent) => {
                  const isDone = completedAgentIds.has(agent.id)
                  const isStarted = introducingAgentIds.has(agent.id)
                  const introText = agentIntros.get(agent.id)
                  return (
                    <motion.div
                      key={agent.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2 }}
                      className="flex items-start gap-3 rounded-lg border border-white/8 bg-surface/50 p-3"
                      style={{
                        opacity: isDone ? 1 : isStarted ? 0.85 : 0.5,
                      }}
                    >
                      <BooAvatar seed={agent.id} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="text-[12px] font-semibold text-text">{agent.name}</span>
                          {isDone ? (
                            <Check size={12} style={{ color: '#34D399' }} />
                          ) : (
                            <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-mint" />
                          )}
                        </div>
                        {introText ? (
                          <p className="text-[11px] leading-relaxed text-secondary/80">
                            {introText}
                          </p>
                        ) : (
                          <p className="text-[10px] italic text-secondary/40">Thinking…</p>
                        )}
                      </div>
                    </motion.div>
                  )
                })}
              </div>
            </motion.div>
          )}

          {phase === 'user-intro' && (
            <motion.div
              key="user-intro"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="mx-auto flex max-w-md flex-col"
            >
              <h3
                className="mb-2 text-center text-[16px] font-semibold text-text"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Your turn — introduce yourself
              </h3>
              <p className="mb-5 text-center text-[12px] leading-relaxed text-secondary">
                Tell the team a bit about yourself: your name, what you&rsquo;re working on, or how
                you&rsquo;d like the team to help. This is saved to each agent&rsquo;s context.
              </p>

              {/* Show agent intros recap (if available) */}
              {agentIntros.size > 0 && (
                <details className="mb-4 rounded-lg border border-white/8 bg-surface/30 p-3">
                  <summary className="cursor-pointer text-[11px] font-semibold text-secondary">
                    Recap: who&rsquo;s on the team
                  </summary>
                  <div className="mt-3 flex flex-col gap-2">
                    {teamAgents.map((agent) => {
                      const intro = agentIntros.get(agent.id)
                      if (!intro) return null
                      return (
                        <div key={agent.id} className="flex items-start gap-2">
                          <BooAvatar seed={agent.id} size={24} />
                          <div className="min-w-0 flex-1">
                            <span className="text-[11px] font-semibold text-text">
                              {agent.name}
                            </span>
                            <p className="text-[10px] text-secondary/70">{intro}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </details>
              )}

              <textarea
                value={userIntroText}
                onChange={(e) => setUserIntroText(e.target.value)}
                placeholder="Hi team! I'm working on…"
                rows={5}
                disabled={submittingUserIntro}
                className="mb-3 w-full rounded-lg border border-white/10 bg-surface/60 px-3 py-2.5 text-[12px] text-text outline-none transition-colors focus:border-accent/60 disabled:opacity-50"
                style={{ resize: 'vertical', minHeight: 100 }}
                data-testid="user-intro-textarea"
              />

              {error && <p className="mb-2 text-[11px] text-accent">{error}</p>}

              <button
                type="button"
                onClick={handleSubmitUserIntro}
                disabled={submittingUserIntro || !client}
                className="inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-[13px] font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: '#E94560', color: '#fff' }}
                data-testid="submit-user-intro"
              >
                {submittingUserIntro ? 'Saving…' : 'Continue to Team Chat'}
                {!submittingUserIntro && <Send size={14} />}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
