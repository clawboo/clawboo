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

import { useMemo, useState, type ReactNode } from 'react'
import { Settings } from 'lucide-react'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useGraphStore } from '@/features/graph/store'
import { countOf } from '@/features/graph/capabilityVocabulary'
import { countGraphSkills } from '@/features/graph/types'
import type { Team } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import type { Room } from '@/stores/rooms'
import { DEFAULT_ROOM_NAME } from '@/lib/roomsClient'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button, IconButton } from '@/features/shared/Button'
import { RoomDialog } from './RoomDialog'
import { TeamSettingsSheet } from './TeamSettingsSheet'
import { CollapsedSidebarToggle } from '@/features/layout/SidebarToggle'

interface GroupChatViewHeaderProps {
  team: Team | null
  /** The chat room being viewed; null = the team's own group chat. */
  room?: Room | null
  /** Show the Boo/skill count pill. Off in the team space, where the counts
   *  sit on the graph card they describe. */
  showCounts?: boolean
  /** Rendered just before the GitHub Star (the team space's card toggles). */
  trailing?: ReactNode
}

/** The team graph's "N Boos · M skills" pill, or an ellipsis until the graph
 *  has rebuilt for THIS team. */
export function TeamGraphCountPill({ teamId }: { teamId: string | null }) {
  // Two separate primitive selectors so we don't need shallow equality —
  // each returns a number and React's default reference check works.
  const booCount = useGraphStore((s) => s.nodes.filter((n) => n.type === 'boo').length)
  const skillCount = useGraphStore((s) => countGraphSkills(s.nodes))
  // The graph store is shared across Atlas + every team graph. Only trust the
  // count once it has STRUCTURALLY rebuilt for THIS team — otherwise a stale
  // count from a previous scope flashes (e.g. "23 Boos" from Atlas before the
  // team graph hydrates).
  const graphScopeKey = useGraphStore((s) => s.graphScopeKey)

  // Don't flash "0 Boos · 0 skills" before the graph hydrates, NOR a stale count
  // from the previous scope — render an ellipsis placeholder until the graph has
  // structurally rebuilt for THIS team AND landed its first node.
  const scopeReady = graphScopeKey === `team:${teamId ?? 'none'}`
  const hasGraph = scopeReady && booCount > 0
  return (
    <>
      {/* Neutral count pill — Boos + skills (accent reserved for active state, not inert counts) */}
      {hasGraph ? (
        <span className="font-data shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-semibold leading-4 text-muted-foreground">
          {booCount} Boo{booCount !== 1 ? 's' : ''}
          {skillCount > 0 && ` · ${countOf(skillCount, 'skill')}`}
        </span>
      ) : (
        <span className="shrink-0 rounded-full bg-foreground/[0.04] px-2 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground">
          …
        </span>
      )}
    </>
  )
}

const ROOM_AVATAR = 20
const ROOM_AVATARS_SHOWN = 4

/** A room's members as a small overlapping stack (the room's "team photo"). */
function RoomMemberStack({ memberIds }: { memberIds: string[] }) {
  const shown = memberIds.slice(0, ROOM_AVATARS_SHOWN)
  const more = memberIds.length - shown.length
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {shown.map((id, i) => (
        <span key={id} style={{ marginLeft: i === 0 ? 0 : -5, zIndex: shown.length - i }}>
          <AgentBooAvatar agentId={id} size={ROOM_AVATAR} />
        </span>
      ))}
      {more > 0 && (
        <span
          className="font-data flex items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-surface"
          style={{ marginLeft: -6, width: ROOM_AVATAR, height: ROOM_AVATAR }}
        >
          +{more}
        </span>
      )}
    </span>
  )
}

export function GroupChatViewHeader({
  team,
  room = null,
  showCounts = true,
  trailing,
}: GroupChatViewHeaderProps) {
  // Open-state for the team-settings sheet — holds the brief + rules
  // editors that used to live in the System panel. Local-state because
  // it doesn't outlive the team-chat view.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [roomEditOpen, setRoomEditOpen] = useState(false)
  // A room's members that are still on the team (the room's chat has exactly
  // these). A joined string, so a fleet status patch does not re-render this.
  const teamAgentIds = useFleetStore((s) =>
    team
      ? s.agents
          .filter((a) => a.teamId === team.id)
          .map((a) => a.id)
          .join('|')
      : '',
  )
  const memberIds = useMemo(() => {
    const onTeam = new Set(teamAgentIds.split('|'))
    return (room?.memberIds ?? []).filter((id) => onTeam.has(id))
  }, [room, teamAgentIds])
  // The team's own chat is the General room: everyone on the team is in it.
  const isGeneral = !room && team != null
  const everyoneIds = useMemo(() => (teamAgentIds ? teamAgentIds.split('|') : []), [teamAgentIds])

  return (
    <>
      {/* 44 px fixed-height row + 12 px horizontal padding — matches the
          rest of the app so the GitHub Star pill lands at exactly the same
          screen coordinates (top:6 right:12) across every view. Team icon
          shrunk 30→24 px and the count pill moved inline (no vertical stack)
          to fit comfortably in 44 px. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <CollapsedSidebarToggle className="-mr-1" />
        {team && (
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[14px]"
            style={{ background: `${team.color}22` }}
          >
            {team.icon}
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {room ? (
            // The team's icon tile sits just before it, so the room's name is
            // enough here; the team name stays in the accessible name and tooltip.
            <h2
              className="min-w-[4.5rem] truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground"
              title={team ? `${team.name} › ${room.name}` : room.name}
              data-testid="room-header-title"
            >
              {team && <span className="sr-only">{team.name}, </span>}
              {room.name}
            </h2>
          ) : isGeneral ? (
            <>
              <h2
                className="min-w-[4.5rem] truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground"
                title={`${team.name} › ${DEFAULT_ROOM_NAME}`}
                data-testid="room-header-title"
              >
                <span className="sr-only">{team.name}, </span>
                {DEFAULT_ROOM_NAME}
              </h2>
              <span
                className="flex shrink-0 items-center p-0.5"
                title={`Everyone on ${team.name}`}
                aria-label={`Everyone on ${team.name} (${everyoneIds.length})`}
              >
                <RoomMemberStack memberIds={everyoneIds} />
              </span>
            </>
          ) : (
            <h2 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {team?.name ?? 'Group Chat'}
            </h2>
          )}
          {room && (
            // The room's members ARE its edit control: one compact target that
            // shows who is here and opens the editor.
            <button
              type="button"
              onClick={() => setRoomEditOpen(true)}
              aria-label={`Edit ${room.name} members (${memberIds.length})`}
              title="Edit room members"
              data-testid="room-edit-button"
              className="flex shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-150 hover:bg-foreground/[0.06]"
            >
              <RoomMemberStack memberIds={memberIds} />
            </button>
          )}
          {showCounts && <TeamGraphCountPill teamId={team?.id ?? null} />}
        </div>
        {/* Team-settings entry point — opens TeamSettingsSheet (brief +
            rules). Icon + text label mirrors the canvas toolbar buttons
            (Re-layout / Connect) so the affordance reads consistently.
            Hidden when no team is active (the "Group Chat" fallback is a
            non-team-scoped view, so there's nothing to configure). */}
        {/* In a room the header also carries the room's name and members, so
            the team-wide settings shrink to their icon there. */}
        {team && (room || isGeneral) && (
          <IconButton
            variant="secondary"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            label={`${team.name} brief & rules`}
            data-testid="team-settings-button"
          >
            <Settings size={14} strokeWidth={2} />
          </IconButton>
        )}
        {team && !room && !isGeneral && (
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
        {trailing}
        <GitHubStarButton />
      </div>
      {settingsOpen && team && (
        <TeamSettingsSheet team={team} onClose={() => setSettingsOpen(false)} />
      )}
      {team && room && (
        <RoomDialog
          open={roomEditOpen}
          onClose={() => setRoomEditOpen(false)}
          teamId={team.id}
          room={room}
        />
      )}
    </>
  )
}
