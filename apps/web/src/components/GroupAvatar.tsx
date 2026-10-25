import type { CSSProperties } from 'react'
import { resolveBooTint } from '@clawboo/ui'
import { AgentBooAvatar, useTeamBooColor } from '@/components/AgentBooAvatar'
import { useBooZeroStore } from '@/stores/booZero'

/**
 * A group's picture, the way messaging apps draw one: each member's face in its
 * own disc, the discs overlapping. One member fills the picture, two sit on a
 * diagonal, three make a triangle, and more than three show two faces and a
 * "+N" disc.
 *
 * The discs are cut out of each other by a ring in `--group-ring`, which the
 * caller sets to the colour behind the picture (it defaults to the surface), so
 * the overlap reads as a clean cut and never as a stray outline.
 */
export function GroupAvatar({ agentIds, size = 32 }: { agentIds: string[]; size?: number }) {
  const n = agentIds.length
  if (n === 0) return <span style={{ width: size, height: size }} aria-hidden />
  if (n === 1) {
    return (
      <span
        className="relative inline-flex shrink-0"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <MemberDisc agentId={agentIds[0]!} diameter={size} />
      </span>
    )
  }
  if (n === 2) {
    const d = Math.round(size * 0.66)
    return (
      <span
        className="relative inline-flex shrink-0"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <MemberDisc agentId={agentIds[1]!} diameter={d} style={{ left: 0, top: 0 }} />
        <MemberDisc agentId={agentIds[0]!} diameter={d} style={{ right: 0, bottom: 0 }} cut />
      </span>
    )
  }
  const d = Math.round(size * 0.58)
  const more = n - 2
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <MemberDisc
        agentId={agentIds[1]!}
        diameter={d}
        style={{ left: 0, top: Math.round(size * 0.04) }}
      />
      {n === 3 ? (
        <MemberDisc agentId={agentIds[2]!} diameter={d} style={{ right: 0, top: 0 }} cut />
      ) : (
        <CountDisc count={more} diameter={d} style={{ right: 0, top: 0 }} />
      )}
      <MemberDisc
        agentId={agentIds[0]!}
        diameter={d}
        style={{ left: Math.round((size - d) / 2), bottom: 0 }}
        cut
      />
    </span>
  )
}

const RING = '0 0 0 1.5px var(--group-ring, var(--surface))'

function MemberDisc({
  agentId,
  diameter,
  style,
  cut = false,
}: {
  agentId: string
  diameter: number
  style?: CSSProperties
  /** Sits in front of another disc, so it is cut out of it. */
  cut?: boolean
}) {
  const isBooZero = useBooZeroStore((s) => s.booZeroAgentId === agentId)
  const tint = useTeamBooColor(agentId, isBooZero) ?? resolveBooTint(agentId, isBooZero)
  return (
    <span
      className="absolute flex items-center justify-center overflow-hidden rounded-full"
      style={{
        width: diameter,
        height: diameter,
        background: `color-mix(in oklab, ${tint} 20%, var(--surface))`,
        boxShadow: [
          `inset 0 0 0 1px color-mix(in oklab, ${tint} 28%, transparent)`,
          cut ? RING : null,
        ]
          .filter(Boolean)
          .join(', '),
        ...style,
      }}
    >
      <span style={{ marginTop: Math.round(diameter * 0.06) }}>
        <AgentBooAvatar agentId={agentId} size={Math.round(diameter * 0.78)} />
      </span>
    </span>
  )
}

function CountDisc({
  count,
  diameter,
  style,
}: {
  count: number
  diameter: number
  style?: CSSProperties
}) {
  return (
    <span
      className="font-data absolute flex items-center justify-center rounded-full bg-muted font-semibold tabular-nums text-muted-foreground"
      style={{
        width: diameter,
        height: diameter,
        fontSize: Math.max(8, Math.round(diameter * 0.42)),
        boxShadow: `inset 0 0 0 1px var(--border), ${RING}`,
        ...style,
      }}
    >
      +{count}
    </span>
  )
}
