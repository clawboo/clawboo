// The shelf's state machine, in one place.
//
// WHY A HOOK AND NOT LOCAL STATE PER CARD. Putting a live action on all 19 cards
// multiplies the async states this surface has to hold: in-flight, waiting on a
// browser tab, popup blocked, saved-but-not-connected. Nineteen copies of that
// drift, and two of them already did earlier in this feature's life. One owner,
// one set of transitions, and the card becomes a pure render of what it is told.
//
// It also owns the two reads the price tag depends on. `live` is which
// connectors are running; `configured` is which ones already have whatever they
// asked for. The second is the difference between a card that says "Needs a key"
// truthfully and one that says it to somebody who entered that key last week.

import { useCallback, useMemo, useState } from 'react'
import {
  byCost,
  isImmediate,
  type ConnectorCost,
  type ConnectorDefinition,
} from '@clawboo/connector-catalog'

import { connectConnector, disconnectConnector, signInConnector } from './connectConnector'
import { useConnectorCostState } from '@/features/connectors/useConnectorCostState'

export interface ConnectorShelf {
  /** Definitions ordered by distance from working. */
  ordered: ConnectorDefinition[]
  costOf: (def: ConnectorDefinition) => ConnectorCost
  /** Whether the operator has stored something for this slug. */
  isConfigured: (slug: string) => boolean
  busy: (slug: string) => boolean
  /** How many of the given set the operator could turn on right now. */
  readyCount: number
  /** Run the card's own action. Resolves once the shelf has caught up. */
  act: (def: ConnectorDefinition, cost: ConnectorCost) => Promise<void>
  refresh: () => void
}

export function useConnectorShelf(
  defs: readonly ConnectorDefinition[],
  /** Called when an action needs more from the user than a card can ask for. */
  openDetail: (def: ConnectorDefinition) => void,
): ConnectorShelf {
  // The two reads the price tag depends on, shared with the in-chat ask card so
  // the two surfaces cannot price the same connector differently.
  const { costOf, isConfigured, refresh } = useConnectorCostState()
  const [busySlugs, setBusySlugs] = useState<ReadonlySet<string>>(new Set())

  const ordered = useMemo(() => byCost(defs, costOf), [defs, costOf])
  const readyCount = useMemo(
    () => defs.filter((d) => isImmediate(costOf(d))).length,
    [defs, costOf],
  )

  const mark = useCallback((slug: string, on: boolean) => {
    setBusySlugs((prev) => {
      const next = new Set(prev)
      if (on) next.add(slug)
      else next.delete(slug)
      return next
    })
  }, [])

  const act = useCallback(
    async (def: ConnectorDefinition, cost: ConnectorCost): Promise<void> => {
      // Everything a card cannot finish on its own hands off to the pane. A key
      // and a folder both need a field; `blocked` needs an explanation and the
      // config to paste somewhere that can actually run it.
      if (
        cost === 'needs-key' ||
        cost === 'needs-folder' ||
        cost === 'not-reviewed' ||
        cost === 'blocked'
      ) {
        openDetail(def)
        return
      }
      mark(def.slug, true)
      try {
        if (cost === 'on') {
          await disconnectConnector(def.slug, def.displayName, def.launch.transport !== 'stdio')
        } else if (cost === 'one-click') {
          // Sign-in alone does not connect: it stores a token. Connecting is the
          // next step, and doing it here is what makes the card's single button
          // mean what it says.
          if (await signInConnector(def.slug, def.displayName)) {
            await connectConnector(def.slug, def.displayName, () => openDetail(def))
          }
        } else {
          await connectConnector(def.slug, def.displayName, () => openDetail(def))
        }
      } finally {
        mark(def.slug, false)
        refresh()
      }
    },
    [mark, openDetail, refresh],
  )

  const busy = useCallback((slug: string) => busySlugs.has(slug), [busySlugs])

  return { ordered, costOf, isConfigured, busy, readyCount, act, refresh }
}
