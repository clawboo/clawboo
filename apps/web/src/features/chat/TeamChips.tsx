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
      className="flex items-center gap-1.5 overflow-x-auto border-t border-white/8 px-4 py-2"
      style={{ scrollbarWidth: 'none' }}
    >
      <span className="shrink-0 text-[10px] text-secondary/40">Tag team:</span>
      {teams.map((team) => (
        <button
          key={team.id}
          type="button"
          onClick={() => onTag(team.name)}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/6 px-2 py-1 transition-colors hover:bg-white/10"
          title={`Tag @${team.name}`}
        >
          <span
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[11px]"
            style={{ background: `${team.color}33` }}
            aria-hidden
          >
            {team.icon}
          </span>
          <span className="max-w-[110px] truncate text-[11px] text-text/80">{team.name}</span>
        </button>
      ))}
    </div>
  )
})
