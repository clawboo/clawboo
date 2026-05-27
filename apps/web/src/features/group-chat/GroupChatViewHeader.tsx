// GroupChatViewHeader — single unified header above the graph + chat split.
// Owns the team identity (icon + name + Boo/skill counts). Boo/skill counts
// were folded into this subtitle to eliminate the redundant "Ghost Graph
// [N Boos · M skills]" subheader row that used to sit between this header
// and the canvas. The user already knows they're looking at a chat-with-
// graph view; the "Ghost Graph" label was noise. Re-layout migrated to the
// canvas's floating toolbar (alongside Team halos + Connect).
//
// The previous `agentCount` prop was dropped — Boo count is more informative
// (includes Boo Zero, matching what the user actually sees on the graph) and
// is sourced from the graph store directly so it stays in sync with the
// canvas without GroupChatView having to plumb it through.

import { useState } from 'react'
import { Settings } from 'lucide-react'
import { useGraphStore } from '@/features/graph/store'
import type { Team } from '@/stores/team'
import { TeamSettingsSheet } from './TeamSettingsSheet'

interface GroupChatViewHeaderProps {
  team: Team | null
}

export function GroupChatViewHeader({ team }: GroupChatViewHeaderProps) {
  // Two separate primitive selectors so we don't need shallow equality —
  // each returns a number and React's default reference check works.
  const booCount = useGraphStore((s) => s.nodes.filter((n) => n.type === 'boo').length)
  const skillCount = useGraphStore((s) => s.nodes.filter((n) => n.type === 'skill').length)

  // Open-state for the team-settings sheet — holds the brief + rules
  // editors that used to live in the System panel. Local-state because
  // it doesn't outlive the team-chat view.
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Don't flash "0 Boos · 0 skills" before the graph hydrates — render an
  // ellipsis placeholder until the structural rebuild lands its first node.
  const hasGraph = booCount > 0
  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        {team && (
          <span
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[16px]"
            style={{ background: `${team.color}22` }}
          >
            {team.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-[14px] font-semibold text-text"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {team?.name ?? 'Group Chat'}
          </h2>
          {/* Accent-red pill badge — same style as the old Ghost Graph
              toolbar badge, so the boo/skill count keeps the same visual
              prominence after being folded into the team header. While the
              graph hydrates we render a dimmer placeholder pill instead of
              "0 Boos · 0 skills" flashing in. */}
          <div className="mt-1.5 flex">
            {hasGraph ? (
              <span className="rounded-full bg-primary/12 px-2.5 py-0.5 text-[11px] font-medium leading-4 text-primary">
                {booCount} Boo{booCount !== 1 ? 's' : ''}
                {skillCount > 0 && ` · ${skillCount} skill${skillCount !== 1 ? 's' : ''}`}
              </span>
            ) : (
              <span className="rounded-full bg-foreground/[0.04] px-2.5 py-0.5 text-[11px] font-medium leading-4 text-foreground/35">
                …
              </span>
            )}
          </div>
        </div>
        {/* Team-settings entry point — opens TeamSettingsSheet (brief +
            rules). Icon + text label mirrors the canvas toolbar buttons
            (Re-layout / Connect) so the affordance reads consistently.
            Hidden when no team is active (the "Group Chat" fallback is a
            non-team-scoped view, so there's nothing to configure). */}
        {team && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label={`${team.name} — brief & rules`}
            title="Team brief & rules"
            data-testid="team-settings-button"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-foreground/[0.04] px-2.5 text-[11px] font-medium text-text/70 transition hover:bg-foreground/[0.08] hover:text-text"
          >
            <Settings size={13} strokeWidth={1.75} />
            Brief &amp; Rules
          </button>
        )}
      </div>
      {settingsOpen && team && (
        <TeamSettingsSheet team={team} onClose={() => setSettingsOpen(false)} />
      )}
    </>
  )
}
