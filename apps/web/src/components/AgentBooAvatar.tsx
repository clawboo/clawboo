import { memo } from 'react'
import { BooAvatar } from '@clawboo/ui'
import { useBooZeroStore } from '@/stores/booZero'

/**
 * BooAvatar wrapper that auto-detects whether the agent is Boo Zero
 * and passes `isBooZero` to force the reserved OpenClaw Red tint.
 *
 * Use this for all agent-context renderings. Use raw `<BooAvatar>`
 * only for preview contexts (e.g. team picker, onboarding) where
 * the agent doesn't exist yet.
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
  return <BooAvatar seed={agentId} size={size} className={className} isBooZero={isBooZero} />
})
