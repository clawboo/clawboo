// Names for the people and agents Home mentions: "you" for the person using the
// page, and each agent by its name in the fleet (a removed agent keeps the name
// the server stored, or reads "an agent").

import { useCallback, useMemo } from 'react'

import { useBoardPerson } from '@/features/board/useBoardPerson'
import { useFleetStore } from '@/stores/fleet'

export interface HomeNames {
  meId: string
  agentName: (id: string) => string | null
}

export function useHomeNames(): HomeNames {
  const me = useBoardPerson()
  const agents = useFleetStore((s) => s.agents)
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const agentName = useCallback((id: string) => byId.get(id) ?? null, [byId])
  return useMemo(() => ({ meId: me.id, agentName }), [me.id, agentName])
}
