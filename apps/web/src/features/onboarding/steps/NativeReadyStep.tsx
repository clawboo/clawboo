// "Your team is ready" — the native first-run landing INSIDE the wizard. Shows
// the seeded leader + specialist, a one-line framing of the shared-memory
// architecture, and a pointer to the Capabilities dashboard. The primary action
// drops the user into the dashboard (native mode, no Gateway).

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Check, Sparkles, Users } from 'lucide-react'

import { BooAvatar } from '@clawboo/ui'
import { NATIVE_STEPS, StepIndicator } from '../StepIndicator'
import { useViewStore } from '@/stores/view'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

interface RosterMember {
  id: string
  name: string
}

export interface NativeReadyStepProps {
  /** The seeded team id (null only if the seed somehow returned none). */
  teamId: string | null
  /** Enter the dashboard, landing in the seeded team. */
  onOpenDashboard: () => void
  /** Enter the dashboard on the Capabilities panel instead of the team. */
  onOpenCapabilities: () => void
}

export function NativeReadyStep({
  teamId,
  onOpenDashboard,
  onOpenCapabilities,
}: NativeReadyStepProps) {
  const [roster, setRoster] = useState<RosterMember[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/agents')
        if (!res.ok) return
        const body = (await res.json()) as {
          agents?: { id: string; displayName?: string; teamId?: string | null }[]
        }
        const members = (body.agents ?? [])
          .filter((a) => teamId && a.teamId === teamId)
          .map((a) => ({ id: a.id, name: a.displayName ?? 'Boo' }))
        if (alive && members.length > 0) setRoster(members)
      } catch {
        /* best-effort — the generic fallback roster renders below */
      }
    })()
    return () => {
      alive = false
    }
  }, [teamId])

  // Fallback so the roster is never empty (the seed always mints these two).
  const members: RosterMember[] =
    roster.length > 0
      ? roster
      : [
          { id: 'lead', name: 'Team Lead' },
          { id: 'coder', name: 'Coder' },
        ]

  return (
    <div
      data-testid="native-ready-step"
      className="surface-overlay-tier w-full max-w-[440px] rounded-2xl p-8"
    >
      <div className="flex flex-col items-center text-center">
        <StepIndicator current="ready" steps={NATIVE_STEPS} />
        <motion.div
          initial={{ scale: 0, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 18 }}
          className="flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: 'rgb(var(--mint-rgb) / 0.14)', color: 'var(--mint)' }}
        >
          <Check size={24} strokeWidth={2.5} />
        </motion.div>
        <h2
          className="mt-4 font-display text-[22px] font-semibold"
          style={{ color: 'var(--foreground)', letterSpacing: '-0.01em' }}
        >
          Your team is ready
        </h2>
        <p
          className="mt-1.5 text-[12px] leading-relaxed"
          style={{ color: muted(0.55), maxWidth: 340 }}
        >
          Two native agents are set up and ready to work.
        </p>
      </div>

      {/* Seeded roster */}
      <div className="mt-6 flex items-center justify-center gap-6">
        {members.map((m) => (
          <div key={m.id} className="flex flex-col items-center gap-2">
            <BooAvatar seed={m.name} size={52} />
            <span className="text-[12px] font-semibold" style={{ color: 'var(--foreground)' }}>
              {m.name}
            </span>
          </div>
        ))}
      </div>

      {/* Shared memory framing (true for a freshly-seeded native team). */}
      <div
        className="mt-6 flex items-start gap-2.5 rounded-xl p-3.5"
        style={{ background: muted(0.04), border: `1px solid ${muted(0.08)}` }}
      >
        <Sparkles size={15} style={{ color: 'var(--mint)', marginTop: 1, flexShrink: 0 }} />
        <p className="text-[11.5px] leading-relaxed" style={{ color: muted(0.62) }}>
          Your agents share one memory — they can recall facts across tasks.
        </p>
      </div>

      {/* Mixed-runtime peer chat (TeamChatRoom). Connect external runtimes later. */}
      <div
        className="mt-2.5 flex items-start gap-2.5 rounded-xl p-3.5"
        style={{ background: muted(0.04), border: `1px solid ${muted(0.08)}` }}
      >
        <Users size={15} style={{ color: 'var(--mint)', marginTop: 1, flexShrink: 0 }} />
        <p className="text-[11.5px] leading-relaxed" style={{ color: muted(0.62) }}>
          Add Claude Code, Codex, Hermes, or OpenClaw as peers anytime — they share one room, and
          any runtime can lead.
        </p>
      </div>

      {/* Primary action */}
      <button
        type="button"
        data-testid="native-open-dashboard"
        onClick={onOpenDashboard}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-semibold transition active:scale-[0.98]"
        style={{
          background: 'var(--primary)',
          color: 'var(--primary-foreground)',
          cursor: 'pointer',
        }}
      >
        Open my dashboard <ArrowRight size={15} />
      </button>

      {/* Quiet pointer to the Capabilities dashboard. */}
      <button
        type="button"
        data-testid="native-open-capabilities"
        onClick={() => {
          useViewStore.getState().navigateTo('capabilities')
          onOpenCapabilities()
        }}
        className="mt-3 w-full text-center text-[11.5px] underline-offset-4 hover:underline"
        style={{ color: muted(0.5), background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        Manage skills &amp; connectors in Capabilities
      </button>
    </div>
  )
}
