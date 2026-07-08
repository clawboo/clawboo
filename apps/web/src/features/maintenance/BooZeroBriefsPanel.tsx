// Boo Zero brief management — *redirected*.
//
// History note: this panel used to host four editors (Display Name, Global
// Brief, Per-Team Briefs, Team Rules) in the System view. That conflated
// agent-scoped surfaces (Display Name + Global Brief belong to Boo Zero) with
// team-scoped surfaces (Per-Team Brief + Team Rules belong to each team).
//
// The editors have moved to where their data actually lives:
//   • Display Name + Global Brief → Boo Zero's individual agent view, in
//     the new `Brief` tab (visible only when viewing Boo Zero).
//   • Per-Team Brief + Team Rules → each team's settings sheet, opened from
//     the gear icon on the team chat header.
//
// This panel is now just a breadcrumb in the System view so users who
// learned the old location can find the new homes in one click.

import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'
import { useToastStore } from '@/stores/toast'
import { ArrowRight, Settings } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'

function RedirectLink({
  icon,
  iconTinted = true,
  title,
  description,
  cta,
  onClick,
  disabled = false,
  disabledReason,
}: {
  icon: React.ReactNode
  /** When false, the icon renders without the accent-tinted disc background. */
  iconTinted?: boolean
  title: string
  description: string
  cta: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : title}
      className={[
        'group flex items-center gap-3.5 rounded-2xl border border-border bg-surface p-4 text-left',
        'transition-[transform,border-color,box-shadow] duration-150',
        disabled ? 'cursor-default opacity-55' : 'cursor-pointer hover:-translate-y-px hover:border-border-strong',
      ].join(' ')}
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={{
          background: iconTinted ? 'rgb(var(--primary-rgb) / 0.12)' : 'rgb(var(--foreground-rgb) / 0.05)',
          color: iconTinted ? 'var(--primary)' : 'var(--foreground)',
        }}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="mb-0.5 text-[13px] font-semibold text-foreground"
          style={{ letterSpacing: '-0.01em' }}
        >
          {title}
        </div>
        <div className="text-[12px] leading-relaxed text-foreground/55">{description}</div>
        {disabled && disabledReason && (
          <div className="mt-1 text-[11px] text-amber">{disabledReason}</div>
        )}
      </div>
      <span
        className={[
          'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium transition-colors',
          disabled
            ? 'text-foreground/35'
            : 'text-foreground/80 group-hover:border-primary/40 group-hover:text-primary',
        ].join(' ')}
      >
        {cta} <ArrowRight size={13} />
      </span>
    </button>
  )
}

// ─── Top-level panel ─────────────────────────────────────────────────────────

export function BooZeroBriefsPanel() {
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const agents = useFleetStore((s) => s.agents)
  const booZeroAgent = booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null

  const teams = useTeamStore((s) => s.teams).filter((t) => !t.isArchived)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  // The team that will actually open when the user clicks the second card:
  // the currently-selected team from the sidebar, falling back to the first
  // un-archived team when nothing is selected. The button label mirrors
  // this resolution so it always reads what's about to open.
  const targetTeam =
    (selectedTeamId ? teams.find((t) => t.id === selectedTeamId) : null) ?? teams[0] ?? null

  const openAgent = useViewStore((s) => s.openAgent)
  const openGroupChat = useViewStore((s) => s.openGroupChat)

  const handleOpenBooZeroBrief = () => {
    if (!booZeroAgent) return
    openAgent(booZeroAgent.id)
    useToastStore.getState().addToast({
      type: 'success',
      message: 'Open the "Brief" tab in the right-hand editor.',
    })
  }

  const handleOpenTeamSettings = () => {
    if (!targetTeam) return
    openGroupChat(targetTeam.id)
    useToastStore.getState().addToast({
      type: 'success',
      message: `Open “Brief & Rules” in ${targetTeam.name}'s chat header.`,
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <RedirectLink
        icon={booZeroAgent ? <BooAvatar seed={booZeroAgent.id} size={26} isBooZero /> : null}
        iconTinted={false}
        title="Boo Zero — Display name & Global brief"
        description="Live in the Boo Zero agent view, in the Brief tab."
        cta="Open Boo Zero"
        onClick={handleOpenBooZeroBrief}
        disabled={!booZeroAgent}
        disabledReason={!booZeroAgent ? 'Boo Zero not identified yet.' : undefined}
      />

      <RedirectLink
        icon={<Settings size={15} />}
        title="Per-team brief & rules"
        description={
          targetTeam
            ? `Open the Brief & Rules button (top right) in ${targetTeam.name}'s chat header.`
            : 'Open a team chat, then click Brief & Rules (top right of the header).'
        }
        cta={targetTeam ? `Open ${targetTeam.name}` : 'No teams yet'}
        onClick={handleOpenTeamSettings}
        disabled={!targetTeam}
        disabledReason={!targetTeam ? 'Deploy a team first.' : undefined}
      />
    </div>
  )
}
