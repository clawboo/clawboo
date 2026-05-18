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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
          e.currentTarget.style.borderColor = 'rgba(233,69,96,0.4)'
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 8,
          background: iconTinted ? 'rgba(233,69,96,0.12)' : 'transparent',
          color: iconTinted ? '#E94560' : 'inherit',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#E8E8E8',
            marginBottom: 2,
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(232,232,232,0.55)', lineHeight: 1.45 }}>
          {description}
        </div>
        {disabled && disabledReason && (
          <div style={{ fontSize: 10, color: '#FBBF24', marginTop: 4 }}>{disabledReason}</div>
        )}
      </div>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 11,
          fontWeight: 500,
          color: disabled ? 'rgba(232,232,232,0.35)' : 'rgba(232,232,232,0.7)',
          flexShrink: 0,
        }}
      >
        {cta} <ArrowRight size={12} />
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
