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
      className="flex items-center gap-1 overflow-x-auto px-4 py-1.5"
      style={{ scrollbarWidth: 'none' }}
    >
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-secondary/40">Teams</span>
      {teams.map((team) => (
        <button
          key={team.id}
          type="button"
          onClick={() => onTag(team.name)}
          className="ml-1 flex shrink-0 items-center gap-1 rounded-full bg-white/5 px-1.5 py-0.5 transition-colors hover:bg-white/10"
          title={`Tag @${team.name}`}
        >
          <span
            className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full text-[10px]"
            style={{ background: `${team.color}33` }}
            aria-hidden
          >
            {team.icon}
          </span>
          <span className="max-w-[100px] truncate text-[10px] text-text/75">{team.name}</span>
        </button>
      ))}
    </div>
  )
})
