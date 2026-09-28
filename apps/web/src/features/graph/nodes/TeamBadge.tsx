import type { CSSProperties } from 'react'
import { useTeamStore } from '@/stores/team'
import { minScreenSize, useZoomStep } from '../useMinScreenSize'

// ─── TeamBadge ───────────────────────────────────────────────────────────────
//
// A team's icon, worn where its branch of the chart meets Boo Zero: the same
// disc the team wears in the sidebar rail, so a branch can be matched to its
// team at a glance. Atlas draws it on each team's junction node; a team's own
// graph draws it on the bend where Boo Zero's edge splits into the team.
//
// Drawn in graph space (it pans and zooms with the chart) with a floor on
// screen, since Atlas usually sits near a 0.25 zoom where the design size alone
// would be a 14px dot around an unreadable emoji.

/** The badge's diameter in graph units at a comfortable zoom. */
export const TEAM_BADGE_SIZE = 56
/** The smallest the badge ever draws on screen, in CSS pixels. */
export const TEAM_BADGE_MIN_SCREEN = 28
/** The canvas-coloured ring around the disc, as a fraction of its diameter. */
export const TEAM_BADGE_RING = 0.07

/** The badge's drawn diameter on screen at `zoom`, for layers placed around it. */
export function teamBadgeScreenSize(zoom: number): number {
  return minScreenSize(TEAM_BADGE_SIZE, TEAM_BADGE_MIN_SCREEN, zoom) * zoom
}

/**
 * The disc itself, centred on its containing block's `(0, 0)`. Renders nothing
 * for a team that no longer exists, rather than a blank circle.
 */
export function TeamBadge({ teamId, style }: { teamId: string; style?: CSSProperties }) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === teamId) ?? null)
  const zoom = useZoomStep()
  const size = minScreenSize(TEAM_BADGE_SIZE, TEAM_BADGE_MIN_SCREEN, zoom)
  if (!team) return null
  return (
    <div
      data-testid="team-junction-badge"
      // The Boos below already carry the team in their accessible names; to a
      // screen reader this disc repeats it. `title` is for the pointer.
      aria-hidden
      title={team.name}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: size,
        height: size,
        transform: 'translate(-50%, -50%)',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: team.color,
        // The canvas-coloured ring cuts the edges where they reach the disc,
        // the way an interchange sits on a transit map, instead of leaving them
        // to run up under its rim.
        boxShadow: `0 0 0 ${size * TEAM_BADGE_RING}px var(--canvas), 0 ${size * 0.05}px ${size * 0.2}px rgb(15 23 42 / 0.22)`,
        fontSize: size * 0.5,
        lineHeight: 1,
        userSelect: 'none',
        cursor: 'default',
        ...style,
      }}
    >
      {team.icon}
    </div>
  )
}
