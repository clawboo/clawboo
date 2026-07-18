// MeetYourTeamCard — the ONE "here is your team, led by Boo Zero" card.
//
// Shared verbatim by the two surfaces that present a freshly-deployed team, so they
// can never drift (the same reason `TeamShowcaseGrid` is shared by onboarding and the
// marketplace):
//   - `TeamOnboardingGate` phase A — the marketplace path's welcome.
//   - `NativeReadyStep`            — the onboarding wizard's payoff step.
//
// Presentational only: no store reads, no fetches. It takes a minimal `{ id, name }`
// member shape (structurally satisfied by `AgentState`) so neither host has to hand it
// a fleet-store type.
//
// `title` / `body` are OPTIONAL because the hosts own their own heading level:
// the gate renders them inside the card, while `NativeReadyStep` sits inside
// `OnboardingScreen`, which already renders the wizard's <h1> + subtitle — passing
// them there would produce two competing headings.

import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'

import { BooAvatar } from '@clawboo/ui'

/** The minimal member shape the card needs — `AgentState` satisfies it structurally. */
export interface TeamMemberLite {
  id: string
  name: string
}

export interface MeetYourTeamCardProps {
  teamAgents: TeamMemberLite[]
  /**
   * Boo Zero — the universal team leader. Drives the header avatar and the
   * "Led by …" badge. It does NOT appear in `teamAgents` (Boo Zero is teamless),
   * which is exactly why the badge exists: without it the user has no way to know
   * who coordinates the team.
   */
  booZeroAgent?: TeamMemberLite | null
  /** Tint for the fallback sparkle when Boo Zero hasn't been identified yet. */
  accentColor?: string | null
  title?: ReactNode
  body?: ReactNode
  /** CTA slot — each host supplies its own forward action. */
  children?: ReactNode
  className?: string
}

export function MeetYourTeamCard({
  teamAgents,
  booZeroAgent,
  accentColor,
  title,
  body,
  children,
  className = '',
}: MeetYourTeamCardProps) {
  return (
    <div
      className={[
        'mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border border-border bg-surface p-8 text-center',
        className,
      ].join(' ')}
      style={{ boxShadow: 'var(--shadow-raised)' }}
      data-testid="meet-your-team-card"
    >
      {/* The universal team leader presents the team — its avatar replaces the
          abstract sparkle for a stronger "leader presenting the team" framing.
          Falls back to the sparkle when Boo Zero hasn't been identified yet. */}
      {booZeroAgent ? (
        <div className="mb-4">
          <BooAvatar seed={booZeroAgent.id} size={56} isBooZero />
        </div>
      ) : (
        <div
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: `${accentColor ?? 'var(--mint)'}22` }}
        >
          <Sparkles size={22} style={{ color: accentColor ?? 'var(--mint)' }} />
        </div>
      )}

      {title ? (
        <h3
          className="mb-2 text-[19px] font-bold text-foreground"
          style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
        >
          {title}
        </h3>
      ) : null}
      {body ? <p className="mb-6 text-[13px] leading-relaxed text-foreground/55">{body}</p> : null}

      {/* Team roster */}
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

      {/* "Led by Boo Zero" — Boo Zero responds first in every team chat even though
          it never appears in the team's sidebar agent list (it is teamless). */}
      {booZeroAgent && (
        <div
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-foreground/[0.02] px-3 py-1.5 text-[11px] text-foreground/60"
          data-testid="led-by-boo-zero-badge"
        >
          <BooAvatar seed={booZeroAgent.id} size={20} />
          <span>
            Led by <strong className="text-foreground">{booZeroAgent.name}</strong> — your universal
            team leader
          </span>
        </div>
      )}

      {children}
    </div>
  )
}
