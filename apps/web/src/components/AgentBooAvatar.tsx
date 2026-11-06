import { memo, useMemo } from 'react'
import { BOO_VARIANTS, BooAvatar, BooVariantAvatar, variantIdForRuntime } from '@clawboo/ui'
import { Pause } from 'lucide-react'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { pauseOfAgent, usePauseStore } from '@/stores/pauses'
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

/** Whether a pause covers this agent. A primitive, so nothing else re-renders the avatar. */
function useAgentPaused(agentId: string): boolean {
  const teamId = useFleetStore((s) => s.agents.find((a) => a.id === agentId)?.teamId ?? null)
  return usePauseStore((s) => pauseOfAgent(s.pauses, agentId, teamId) !== null)
}

/** svg height / width of the generated mascot, whose viewBox is `0 0 100 92`. */
export const MASCOT_ASPECT = 92 / 100

/**
 * The variant an agent draws, or `null` when it draws the generated mascot.
 *
 * Boo Zero short-circuits ahead of the runtime: it is the product's own mark, so it keeps the
 * generated mascot and its reserved red whatever it runs on. The runtime is read as a primitive,
 * like every other selector here, so fleet patches during streaming (status flips, token counts)
 * don't re-render the avatar.
 */
function useAgentBooVariant(agentId: string, isBooZero: boolean) {
  const runtime = useFleetStore((s) => s.agents.find((a) => a.id === agentId)?.runtime ?? null)
  return isBooZero ? null : variantIdForRuntime(runtime)
}

/**
 * The svg height / width the agent's avatar will draw at.
 *
 * A caller that positions anything under the mark needs this: the variants are squarer than the
 * generated mascot, so a layout that assumes the mascot's 0.92 leaves a variant overhanging its
 * own box. It reads the registry's metadata, which is data alone, so asking costs no artwork.
 */
export function useAgentBooAspect(agentId: string): number {
  const isBooZero = useBooZeroStore((s) => s.booZeroAgentId === agentId)
  const variantId = useAgentBooVariant(agentId, isBooZero)
  return variantId ? BOO_VARIANTS[variantId].aspect : MASCOT_ASPECT
}

/**
 * The avatar for an agent that exists: either its runtime's locked brand Boo, or the mascot
 * generated from its seed.
 *
 * Codex, Claude Code and Hermes agents get their runtime's approved artwork, which is fixed brand
 * art and identical for every agent on that runtime apart from its colour. Every other runtime, and
 * an agent whose runtime is unknown or missing, keeps the generated mascot painted with its team's
 * palette color. Boo Zero always keeps the generated mascot and its reserved OpenClaw Red, whatever
 * its runtime: it is the product's own mark, not the runtime's.
 *
 * Use this for all agent-context renderings. Use raw `<BooAvatar>` only for preview contexts (e.g.
 * team picker, onboarding) where the agent doesn't exist yet.
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
  const { resolvedTheme } = useTheme()
  const isBooZero = useBooZeroStore((s) => s.booZeroAgentId === agentId)
  const tint = useTeamBooColor(agentId, isBooZero)
  const variantId = useAgentBooVariant(agentId, isBooZero)
  const paused = useAgentPaused(agentId)

  // `tint` is undefined for a teamless agent, and a variant reads that as "keep your own locked
  // colour", which is exactly the intent. It is passed as null so the prop's meaning is stated
  // rather than left to an absent value.
  const avatar = variantId ? (
    <BooVariantAvatar
      variantId={variantId}
      tint={tint ?? null}
      surface={resolvedTheme}
      size={size}
      className={className}
    />
  ) : (
    <BooAvatar seed={agentId} size={size} className={className} isBooZero={isBooZero} tint={tint} />
  )
  if (!paused) return avatar

  // Every face of an agent goes through here, so a paused agent looks paused wherever it shows.
  // The wrapper exists only while it is paused, so nothing about a running agent's layout changes.
  // Capped, and in the far corner on a large face, where the Org chart's runtime badge is not.
  const face = size ?? 32
  const mark = Math.min(18, Math.max(10, Math.round(face * 0.34)))
  const corner = face >= 48 ? '-left-0.5 -top-0.5' : '-bottom-0.5 -right-0.5'
  return (
    <span className="relative inline-flex shrink-0" data-testid={`agent-paused-${agentId}`}>
      {avatar}
      <span
        title="Paused"
        className={`absolute ${corner} flex items-center justify-center rounded-full border border-border bg-popover text-muted-foreground`}
        style={{ width: mark, height: mark }}
      >
        <Pause size={Math.round(mark * 0.6)} strokeWidth={2.5} aria-hidden />
        <span className="sr-only">Paused</span>
      </span>
    </span>
  )
})
