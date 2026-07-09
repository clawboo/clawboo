// TeamOnboardingGate — the two-phase onboarding flow that gates the normal team
// chat composer, keyed off the team's server-persisted onboarding flags.
//
// Phase A: "Meet your team" welcome — the roster + the universal leader (Boo Zero).
// Phase C: User self-introduction — persisted to SQLite (the source of truth for the
//          server-side context preamble) + best-effort to each agent's SOUL.md.
//
// The old Phase B (each agent auto-introducing itself over the Gateway) is GONE: it
// was a browser-cascade-prevention artifact of the retired browser orchestration.
// The SERVER engine now prevents cascades by design (structured signals + nudge queue
// + stop generation + idle watchdog), and the team is understood via the welcome
// (roster + leader + "just ask") plus show-don't-tell (the first real task reveals the
// team live in chat + the board cards). Dropping Phase B also lets the gate work with
// NO Gateway client (native / server-orchestrated teams, `client === null`).

import { useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Send, ArrowRight } from 'lucide-react'
import type { TranscriptEntry } from '@clawboo/protocol'
import { BooAvatar } from '@clawboo/ui'
import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'
import { useChatStore } from '@/stores/chat'
import { useToastStore } from '@/stores/toast'
import { buildTeamSessionKey } from '@/lib/sessionUtils'
import { nextSeq } from '@/lib/sequenceKey'
import { syncBooZeroSoulIdentity } from '@/lib/booZeroIdentitySync'
import { readAgentFile, writeAgentFile } from '@clawboo/control-client'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamOnboardingGateProps {
  teamId: string
  team: Team | null
  teamAgents: AgentState[]
  /**
   * Boo Zero — the universal team leader. When present, the welcome card shows a
   * "Led by <BooZero Name>" badge so the user knows Boo Zero is the team's
   * coordinator (it does NOT appear in the team's sidebar agent list — it's teamless).
   */
  booZeroAgent?: AgentState | null
  agentsIntroduced: boolean
  userIntroduced: boolean
  onMarkAgentsIntroduced: () => Promise<void>
  onMarkUserIntroduced: (introText: string) => Promise<void>
}

type Phase = 'welcome' | 'user-intro'

function buildUserIntroSoulPatch(userIntro: string): string {
  return `\n\n## About the User\n${userIntro.trim()}\n`
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TeamOnboardingGate({
  teamId,
  team,
  teamAgents,
  booZeroAgent,
  agentsIntroduced,
  userIntroduced: _userIntroduced,
  onMarkAgentsIntroduced,
  onMarkUserIntroduced,
}: TeamOnboardingGateProps) {
  // Determine starting phase from server-persisted state: a returning mid-onboarding
  // user who already advanced past the welcome lands directly on the user-intro.
  const initialPhase: Phase = agentsIntroduced ? 'user-intro' : 'welcome'
  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [userIntroText, setUserIntroText] = useState<string>('')
  const [submittingUserIntro, setSubmittingUserIntro] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const booZeroName = booZeroAgent?.name ?? 'Boo Zero'

  // ── Phase A action: advance to the user's self-introduction ────────────────
  const handleKnowYourTeam = useCallback(() => {
    // No agent intro parade — the team is led by Boo Zero (the coordinator). Advance
    // straight to the user's self-introduction. Mark agents introduced so the gate's
    // server flags stay consistent; best-effort (the phase advance is optimistic).
    setError(null)
    setPhase('user-intro')
    void onMarkAgentsIntroduced().catch(() => {
      /* non-fatal — the local phase already advanced */
    })
  }, [onMarkAgentsIntroduced])

  // ── Phase C action: submit user introduction ──────────────────────────────
  const handleSubmitUserIntro = useCallback(async () => {
    const trimmed = userIntroText.trim()
    if (trimmed.length < 5) {
      setError('Please write a short introduction (at least 5 characters).')
      return
    }
    setError(null)
    setSubmittingUserIntro(true)

    const patchBlock = buildUserIntroSoulPatch(trimmed)

    // Append to each agent's SOUL.md (idempotent: only if "## About the User"
    // is not already present). Best-effort per agent, via the AgentSource REST client
    // (NOT the Gateway client — so this works for native / server-orchestrated teams).
    //
    // Gateway `agents.files.set('SOUL.md')` is known to be unreliable for persistence
    // in older runtimes, so the SOUL.md write is best-effort; the SQLite-backed user
    // intro (below) is the SOURCE OF TRUTH, injected into the server-side team context
    // preamble on every group-chat turn.
    const writePromises = teamAgents.map(async (agent) => {
      try {
        let current = ''
        try {
          current = await readAgentFile(agent.id, 'SOUL.md')
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
        await writeAgentFile(agent.id, 'SOUL.md', next)
      } catch {
        // Non-fatal — one agent failing doesn't block the gate from opening.
      }
    })
    await Promise.allSettled(writePromises)

    // Boo Zero SOUL.md sync — submitting the user intro is the per-team onboarding
    // "approval moment", the right point to re-anchor Boo Zero's persisted identity
    // with its current display name. Best-effort.
    if (booZeroAgent) {
      void syncBooZeroSoulIdentity({
        agentId: booZeroAgent.id,
        displayName: booZeroAgent.name,
      })
    }

    // Acknowledge the user IN CHARACTER as Boo Zero (the universal team leader) so
    // submitting their intro feels like the team RECEIVED them. We surface the user's
    // intro as a "You" message followed by a warm Boo Zero reply that puts the ball
    // back in the user's court. Both are CLIENT-SIDE entries (no Gateway round-trip),
    // so they appear instantly and carry zero cascade risk. If Boo Zero isn't
    // identified yet (rare), fall back to a single neutral meta confirmation.
    if (booZeroAgent) {
      const booTeamSk = buildTeamSessionKey(booZeroAgent.id, teamId)
      const now = Date.now()
      const youEntry: TranscriptEntry = {
        entryId: crypto.randomUUID(),
        runId: null,
        sessionKey: booTeamSk,
        kind: 'user',
        role: 'user',
        text: trimmed,
        source: 'local-send',
        timestampMs: now,
        sequenceKey: nextSeq(),
        confirmed: true,
        fingerprint: crypto.randomUUID(),
      }
      const ackEntry: TranscriptEntry = {
        entryId: crypto.randomUUID(),
        runId: null,
        sessionKey: booTeamSk,
        kind: 'assistant',
        role: 'assistant',
        text: `Thanks for the intro — I've shared it with the team, so we're all on the same page. What would you like to start with?`,
        source: 'local-send',
        // +1ms so the leader's reply sorts AFTER the user's message.
        timestampMs: now + 1,
        sequenceKey: nextSeq(),
        confirmed: true,
        fingerprint: crypto.randomUUID(),
      }
      useChatStore.getState().appendTranscript(booTeamSk, [youEntry, ackEntry])
    } else {
      const ackAgentId = teamAgents[0]?.id
      if (ackAgentId) {
        const teamSk = buildTeamSessionKey(ackAgentId, teamId)
        const entry: TranscriptEntry = {
          entryId: crypto.randomUUID(),
          runId: null,
          sessionKey: teamSk,
          kind: 'meta',
          role: 'system',
          text: 'Your introduction was saved — the team has it in context.',
          source: 'local-send',
          timestampMs: Date.now(),
          // Strictly-increasing tiebreaker (see lib/sequenceKey.ts).
          sequenceKey: nextSeq(),
          confirmed: true,
          fingerprint: crypto.randomUUID(),
        }
        useChatStore.getState().appendTranscript(teamSk, [entry])
      }
    }

    try {
      // Persist user intro to SQLite — the SOURCE OF TRUTH. Even if the SOUL.md writes
      // above silently fail, the intro is preserved here and injected into the
      // server-side team context preamble on every group-chat turn.
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
  }, [userIntroText, teamAgents, teamId, booZeroAgent, onMarkUserIntroduced])

  // ── Render ─────────────────────────────────────────────────────────────────
  // No local header — `GroupChatViewHeader` (rendered by `GroupChatView` above the
  // graph + chat split) already shows the team identity.
  return (
    <div className="flex h-full flex-col bg-background">
      {/* Content — vertically centered so the (short) welcome / user-intro states sit
          in the MIDDLE of the full-window gate, falling back to top-aligned scrolling
          when a phase grows taller than the viewport. */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center px-6 py-8">
          <AnimatePresence mode="wait">
            {phase === 'welcome' && (
              <motion.div
                key="welcome"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border border-border bg-surface p-8 text-center"
                style={{ boxShadow: 'var(--shadow-raised)' }}
              >
                {/* The universal team leader (Boo Zero) presents the team — its avatar
                  replaces the abstract sparkle icon for a stronger "leader presenting
                  the team" framing. Falls back to the sparkle in a colored ring when
                  Boo Zero hasn't been identified (rare — a brief window before
                  `identifyBooZero` lands after first hydrate). */}
                {booZeroAgent ? (
                  <div className="mb-4">
                    <BooAvatar seed={booZeroAgent.id} size={56} isBooZero />
                  </div>
                ) : (
                  <div
                    className="mb-4 flex h-12 w-12 items-center justify-center rounded-full"
                    style={{ background: `${team?.color ?? 'var(--mint)'}22` }}
                  >
                    <Sparkles size={22} style={{ color: team?.color ?? 'var(--mint)' }} />
                  </div>
                )}
                <h3
                  className="mb-2 text-[19px] font-bold text-foreground"
                  style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
                >
                  Meet your team
                </h3>
                <p className="mb-6 text-[13px] leading-relaxed text-foreground/55">
                  Your team of {teamAgents.length} is led by {booZeroName}, who takes your request
                  and routes it to the right specialist. You don&rsquo;t need to track who does what.
                  Just tell the team what you need to get started.
                </p>

                {/* Agent avatars */}
                <div className="mb-5 flex flex-wrap items-center justify-center gap-3">
                  {teamAgents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex flex-col items-center gap-1.5"
                      style={{ minWidth: 64 }}
                    >
                      <BooAvatar seed={agent.id} size={40} />
                      <span className="max-w-[80px] truncate text-[10.5px] font-medium text-foreground/60">
                        {agent.name}
                      </span>
                    </div>
                  ))}
                </div>

                {/* "Led by Boo Zero" badge — Boo Zero is the universal team leader and
                  responds first in every team chat, even though it doesn't appear in
                  the team's sidebar agent list. */}
                {booZeroAgent && (
                  <div
                    className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-foreground/[0.02] px-3 py-1.5 text-[11px] text-foreground/60"
                    data-testid="led-by-boo-zero-badge"
                  >
                    <BooAvatar seed={booZeroAgent.id} size={20} />
                    <span>
                      Led by <strong className="text-foreground">{booZeroAgent.name}</strong> — your
                      universal team leader
                    </span>
                  </div>
                )}

                <Button
                  variant="primary"
                  size="lg"
                  onClick={handleKnowYourTeam}
                  disabled={teamAgents.length === 0}
                  data-testid="know-your-team-button"
                >
                  Get Started
                  <ArrowRight size={16} strokeWidth={2} />
                </Button>
              </motion.div>
            )}

            {phase === 'user-intro' && (
              <motion.div
                key="user-intro"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="mx-auto flex w-full max-w-xl flex-col rounded-2xl border border-border bg-surface p-8"
                style={{ boxShadow: 'var(--shadow-raised)' }}
              >
                <h3
                  className="mb-2 text-center text-[18px] font-bold text-foreground"
                  style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
                >
                  Your turn — introduce yourself
                </h3>
                <p className="mb-5 text-center text-[13px] leading-relaxed text-foreground/55">
                  Tell the team a bit about yourself: your name, what you&rsquo;re working on, or
                  how you&rsquo;d like the team to help. This is saved to the team&rsquo;s context.
                </p>

                <textarea
                  value={userIntroText}
                  onChange={(e) => setUserIntroText(e.target.value)}
                  placeholder="Hi team! I'm working on…"
                  rows={5}
                  disabled={submittingUserIntro}
                  className="mb-4 w-full rounded-xl border border-border bg-surface px-4 py-3 text-[14px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50"
                  style={{ resize: 'vertical', minHeight: 110 }}
                  data-testid="user-intro-textarea"
                />

                {error && (
                  <div className="mb-3">
                    <FormattedAlert tone="error">{error}</FormattedAlert>
                  </div>
                )}

                <Button
                  variant="primary"
                  size="lg"
                  onClick={handleSubmitUserIntro}
                  loading={submittingUserIntro}
                  data-testid="submit-user-intro"
                >
                  {submittingUserIntro ? 'Saving…' : 'Continue to Team Space'}
                  {!submittingUserIntro && <Send size={16} strokeWidth={2} />}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
