import { memo, useMemo } from 'react'
import { BooAvatar } from '@clawboo/ui'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useTheme } from '@/features/theme/useTheme'
import { DEFAULT_COLLECTION_ID } from '@/lib/teamPalettes'
import { pickBooColor } from '@/lib/resolveTeamBooColor'

/**
 * Resolve a Boo's color from its team's chosen palette collection, adapted to
 * the active theme. Selectors return primitives (teamId, collectionId, a member
 * signature string) so frequent fleet patches (status flips during streaming)
 * don't re-render the avatar — only an actual color change does.
 *
 * Returns `undefined` for Boo Zero / teamless / unknown agents, so the avatar
 * keeps its reserved red or hashed fallback tint.
 */
export function useTeamBooColor(agentId: string, isBooZero: boolean): string | undefined {
  const { resolvedTheme } = useTheme()
  const booZeroId = useBooZeroStore((s) => s.booZeroAgentId)
  const teamId = useFleetStore((s) => s.agents.find((a) => a.id === agentId)?.teamId ?? null)
  const collectionId = useTeamStore((s) =>
    teamId
      ? (s.teams.find((t) => t.id === teamId)?.colorCollectionId ?? DEFAULT_COLLECTION_ID)
      : null,
  )
  // Stable-sorted team membership (Boo Zero excluded) as a string, so the
  // selector only triggers a re-render when the roster actually changes.
  const membersSig = useFleetStore((s) =>
    teamId
      ? s.agents
          .filter((a) => a.teamId === teamId && a.id !== booZeroId)
          .map((a) => a.id)
          .sort()
          .join('|')
      : '',
  )

  return useMemo(() => {
    if (isBooZero || !teamId || !collectionId) return undefined
    const members = membersSig ? membersSig.split('|') : []
    // Seed with teamId so same-collection teams get distinct rotated palettes.
    return pickBooColor(collectionId, members, agentId, resolvedTheme, teamId)
  }, [isBooZero, teamId, collectionId, membersSig, agentId, resolvedTheme])
}

/**
 * BooAvatar wrapper that auto-detects whether the agent is Boo Zero (forces the
 * reserved OpenClaw Red tint) and otherwise paints the agent with its team's
 * generated palette color.
 *
 * Use this for all agent-context renderings. Use raw `<BooAvatar>` only for
 * preview contexts (e.g. team picker, onboarding) where the agent doesn't exist
 * yet.
 */
export const AgentBooAvatar = memo(function AgentBooAvatar({
  agentId,
  size,
  className,
}: {
  agentId: string
  size?: number
  className?: string
}) {
  const isBooZero = useBooZeroStore((s) => s.booZeroAgentId === agentId)
  const tint = useTeamBooColor(agentId, isBooZero)
  return (
    <BooAvatar seed={agentId} size={size} className={className} isBooZero={isBooZero} tint={tint} />
  )
})
