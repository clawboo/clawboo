import { Plus } from 'lucide-react'
import { useTeamStore, type Team } from '@/stores/team'

// ─── MascotIcon ──────────────────────────────────────────────────────────────

function MascotIcon({ selected, onClick }: { selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="All Agents"
      style={{
        width: 40,
        height: 40,
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: selected ? '2px solid #E94560' : '2px solid transparent',
        background: selected ? 'rgba(233,69,96,0.12)' : 'rgba(255,255,255,0.04)',
        cursor: 'pointer',
        transition: 'all 0.15s',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <img src="/logo.svg" width={26} height={24} alt="All teams" />
    </button>
  )
}

// ─── TeamIcon ────────────────────────────────────────────────────────────────

function TeamIcon({
  team,
  selected,
  onClick,
}: {
  team: Team
  selected: boolean
  onClick: () => void
}) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      {/* Discord-style selected pill on left edge */}
      {selected && (
        <div
          style={{
            position: 'absolute',
            left: -8,
            width: 4,
            height: 20,
            borderRadius: '0 4px 4px 0',
            background: '#E8E8E8',
          }}
        />
      )}
      <button
        onClick={onClick}
        title={team.name}
        style={{
          width: 40,
          height: 40,
          borderRadius: selected ? 12 : 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          background: team.color || 'rgba(255,255,255,0.06)',
          cursor: 'pointer',
          transition: 'all 0.15s',
          padding: 0,
          flexShrink: 0,
          fontSize: 20,
          lineHeight: 1,
        }}
        onMouseOver={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.borderRadius = '12px'
        }}
        onMouseOut={(e) => {
          if (!selected) {
            ;(e.currentTarget as HTMLButtonElement).style.borderRadius = '20px'
          }
        }}
      >
        {team.icon}
      </button>
    </div>
  )
}

// ─── TeamSidebar ─────────────────────────────────────────────────────────────

export function TeamSidebar() {
  const teams = useTeamStore((s) => s.teams)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const selectTeam = useTeamStore((s) => s.selectTeam)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: 60,
        height: '100%',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        background: '#080B14',
        paddingTop: 12,
        paddingBottom: 12,
        gap: 8,
        flexShrink: 0,
      }}
    >
      {/* Mascot — selects "All Agents" */}
      <MascotIcon selected={selectedTeamId === null} onClick={() => selectTeam(null)} />

      {/* Divider */}
      <div
        style={{
          width: 32,
          borderTop: '1px solid rgba(255,255,255,0.08)',
          marginTop: 2,
          marginBottom: 2,
          flexShrink: 0,
        }}
      />

      {/* Team icons */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          paddingLeft: 10,
          paddingRight: 10,
        }}
      >
        {teams.map((team) => (
          <TeamIcon
            key={team.id}
            team={team}
            selected={team.id === selectedTeamId}
            onClick={() => selectTeam(team.id)}
          />
        ))}
      </div>

      {/* Add team button (placeholder) */}
      <button
        title="Create team"
        disabled
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed rgba(255,255,255,0.12)',
          background: 'transparent',
          color: 'rgba(232,232,232,0.3)',
          cursor: 'not-allowed',
          padding: 0,
          flexShrink: 0,
          transition: 'all 0.15s',
        }}
      >
        <Plus size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
