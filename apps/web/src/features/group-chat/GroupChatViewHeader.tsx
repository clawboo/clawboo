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
import { MessagesSquare, Settings } from 'lucide-react'
import { useGraphStore } from '@/features/graph/store'
import type { Team } from '@/stores/team'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button } from '@/features/shared/Button'
import { TeamSettingsSheet } from './TeamSettingsSheet'
import { TeamChatRoom } from './TeamChatRoom'

interface GroupChatViewHeaderProps {
  team: Team | null
}

export function GroupChatViewHeader({ team }: GroupChatViewHeaderProps) {
  // Two separate primitive selectors so we don't need shallow equality —
  // each returns a number and React's default reference check works.
  const booCount = useGraphStore((s) => s.nodes.filter((n) => n.type === 'boo').length)
  const skillCount = useGraphStore((s) => s.nodes.filter((n) => n.type === 'skill').length)
  // The graph store is shared across Atlas + every team graph. Only trust the
  // count once it has STRUCTURALLY rebuilt for THIS team — otherwise a stale
  // count from a previous scope flashes (e.g. "23 Boos" from Atlas before the
  // team graph hydrates).
  const graphScopeKey = useGraphStore((s) => s.graphScopeKey)

  // Open-state for the team-settings sheet — holds the brief + rules
  // editors that used to live in the System panel. Local-state because
  // it doesn't outlive the team-chat view.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The peer-chat room — every teammate as a named author, any runtime can
  // lead. A right-slide drawer so it never disturbs the aspect-sensitive graph split.
  const [roomOpen, setRoomOpen] = useState(false)

  // Don't flash "0 Boos · 0 skills" before the graph hydrates, NOR a stale count
  // from the previous scope — render an ellipsis placeholder until the graph has
  // structurally rebuilt for THIS team AND landed its first node.
  const scopeReady = graphScopeKey === `team:${team?.id ?? 'none'}`
  const hasGraph = scopeReady && booCount > 0
  return (
    <>
      {/* 44 px fixed-height row + 12 px horizontal padding — matches the
          rest of the app so the GitHub Star pill lands at exactly the same
          screen coordinates (top:6 right:12) across every view. Team icon
          shrunk 30→24 px and the count pill moved inline (no vertical stack)
          to fit comfortably in 44 px. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        {team && (
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[14px]"
            style={{ background: `${team.color}22` }}
          >
            {team.icon}
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
            {team?.name ?? 'Group Chat'}
          </h2>
          {/* Neutral count pill — Boos + skills (accent reserved for active state, not inert counts) */}
          {hasGraph ? (
            <span className="font-data shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-semibold leading-4 text-foreground/55">
              {booCount} Boo{booCount !== 1 ? 's' : ''}
              {skillCount > 0 && ` · ${skillCount} skill${skillCount !== 1 ? 's' : ''}`}
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-foreground/[0.04] px-2 py-0.5 text-[10px] font-medium leading-4 text-foreground/35">
              …
            </span>
          )}
        </div>
        {/* Team-settings entry point — opens TeamSettingsSheet (brief +
            rules). Icon + text label mirrors the canvas toolbar buttons
            (Re-layout / Connect) so the affordance reads consistently.
            Hidden when no team is active (the "Group Chat" fallback is a
            non-team-scoped view, so there's nothing to configure). */}
        {team && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRoomOpen(true)}
            aria-label={`${team.name} — team room`}
            title="Team room — peers, any runtime can lead"
            data-testid="team-room-button"
          >
            <MessagesSquare size={14} strokeWidth={2} />
            Team room
          </Button>
        )}
        {team && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            aria-label={`${team.name} — brief & rules`}
            title="Team brief & rules"
            data-testid="team-settings-button"
          >
            <Settings size={14} strokeWidth={2} />
            Brief &amp; Rules
          </Button>
        )}
        {/* GitHub Star CTA — integrated into the team header so this view
            doesn't need the global AppTopBar (which is hidden for groupChat
            views). Saves 44 px of always-on chrome by reusing the team
            header row. */}
        <GitHubStarButton />
      </div>
      {settingsOpen && team && (
        <TeamSettingsSheet team={team} onClose={() => setSettingsOpen(false)} />
      )}
      {roomOpen && team && <TeamChatRoom teamId={team.id} onClose={() => setRoomOpen(false)} />}
    </>
  )
}
