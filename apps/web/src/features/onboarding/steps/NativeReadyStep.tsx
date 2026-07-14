// "Your team is ready" — the native first-run landing INSIDE the wizard. Shows
// the seeded leader + specialist and a one-line framing of the shared-memory
// architecture. The single primary action drops the user into the dashboard,
// landing in their seeded team (native mode, no Gateway).

import { type ReactNode, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Sparkles, Users } from 'lucide-react'

import { BooAvatar } from '@clawboo/ui'
import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'

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
}

function InfoRow({ icon: Icon, children }: { icon: typeof Sparkles; children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-3 rounded-2xl p-4 text-left"
      style={{ background: muted(0.035), border: `1px solid ${muted(0.07)}` }}
    >
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'rgb(var(--mint-rgb) / 0.12)', color: 'var(--mint)' }}
      >
        <Icon size={15} />
      </span>
      <p className="text-[13px] leading-relaxed" style={{ color: muted(0.62) }}>
        {children}
      </p>
    </div>
  )
}

export function NativeReadyStep({ teamId, onOpenDashboard }: NativeReadyStepProps) {
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

  // The deployed team's real roster (fetched above). Cap the shown faces so a
  // large team doesn't overflow the row; the exact count is in the subtitle.
  const shown = roster.slice(0, 5)

  return (
    <OnboardingScreen
      testId="native-ready-step"
      step="ready"
      steps={NATIVE_STEPS}
      align="center"
      title="Your team is ready"
      subtitle={
        roster.length > 0
          ? `${roster.length} agent${roster.length === 1 ? '' : 's'} deployed and ready to work. Say hi whenever you are.`
          : 'Your team is deployed and ready to work. Say hi whenever you are.'
      }
    >
      {/* Deployed roster — the payoff */}
      <div className="flex flex-wrap items-end justify-center gap-8">
        {shown.map((m, i) => (
          <motion.div
            key={m.id}
            initial={{ scale: 0.7, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.05 + i * 0.08 }}
            className="flex flex-col items-center gap-2.5"
          >
            <BooAvatar seed={m.name} size={68} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>
              {m.name}
            </span>
          </motion.div>
        ))}
      </div>

      {/* Architecture framing (true for a freshly-seeded native team). */}
      <div className="mt-9 flex flex-col gap-2.5">
        <InfoRow icon={Sparkles}>
          Your agents share one memory, so they recall facts across tasks.
        </InfoRow>
        <InfoRow icon={Users}>
          Add Claude Code, Codex, Hermes, or OpenClaw as peers anytime. They share one room, and any
          runtime can lead.
        </InfoRow>
      </div>

      {/* Primary action */}
      <div className="mt-9 flex justify-center">
        <OnboardingPrimary
          testId="native-open-dashboard"
          onClick={onOpenDashboard}
          className="w-full sm:w-auto"
        >
          Open my dashboard <ArrowRight size={16} />
        </OnboardingPrimary>
      </div>
    </OnboardingScreen>
  )
}
