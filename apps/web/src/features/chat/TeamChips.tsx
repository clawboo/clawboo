// TeamChips — horizontal row of team-emoji chips for quick @TeamName tagging.
// Mirrors AgentChips visually but lives in `ChatPanel` (Boo Zero's individual
// chat) and tags team names via `parseTeamOrAgentMention`. Clicking a chip
// inserts `@<TeamName>` at the start of the composer draft.

import { memo } from 'react'

interface TeamChipsProps {
  teams: { id: string; name: string; icon: string; color: string }[]
  onTag: (teamName: string) => void
}

export const TeamChips = memo(function TeamChips({ teams, onTag }: TeamChipsProps) {
  if (teams.length === 0) return null

  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto px-6 py-2"
      style={{ scrollbarWidth: 'none' }}
    >
      <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
        Teams
      </span>
      {teams.map((team) => (
        <button
          key={team.id}
          type="button"
          onClick={() => onTag(team.name)}
          className="ml-0.5 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-foreground/70 transition-all duration-150 hover:border-border-strong hover:text-foreground"
          title={`Tag @${team.name}`}
        >
          <span
            className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full text-[10px]"
            style={{ background: `${team.color}33` }}
            aria-hidden
          >
            {team.icon}
          </span>
          <span className="max-w-[110px] truncate text-[12.5px] font-medium">{team.name}</span>
        </button>
      ))}
    </div>
  )
})
