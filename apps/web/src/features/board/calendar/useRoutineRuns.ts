// The upcoming runs of the routines the board's calendar is showing: one server
// read per range and team filter, refreshed every 30 seconds. Runs move far less
// often than tasks, so they poll slower than the board's five seconds. The read
// runs whether or not the runs are drawn, since the Routines switch shows their
// count while it hides them.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchRoutineOccurrences, type RoutineOccurrences } from '@/lib/schedulesClient'
import { useReadSequencer } from '@/lib/useReadSequencer'
import { useVisiblePolling } from '@/lib/useVisiblePolling'

import { rangeBounds, type CalendarRange } from './calendarModel'

const NONE: RoutineOccurrences[] = []

export interface RoutineRunsState {
  /** The runs for exactly this range and filter; empty until they arrive. */
  routines: RoutineOccurrences[]
  /** True once a read for this range and filter has answered, or none is needed. */
  settled: boolean
  /** The zone the scheduler fires in, as the server last said. */
  timeZone: string | null
  refresh: () => Promise<void>
}

export function useRoutineRuns(range: CalendarRange | null, teamFilter: string): RoutineRunsState {
  // Everything the read depends on, as one string, so a new range or filter is a
  // new read and an answer for an older one can never be drawn on these days. The
  // undated board has no days, so it reads nothing.
  const key = useMemo(
    () => (range ? `${rangeBounds(range).join(',')}|${teamFilter}` : null),
    [range, teamFilter],
  )
  const [state, setState] = useState<{ key: string; routines: RoutineOccurrences[] } | null>(null)
  const [answered, setAnswered] = useState<string | null>(null)
  const [timeZone, setTimeZone] = useState<string | null>(null)
  const reads = useReadSequencer()

  const refresh = useCallback(async () => {
    if (!key) return
    const [boundsPart = '', team = 'all'] = key.split('|')
    const read = reads.beginRead()
    const view = await fetchRoutineOccurrences(
      boundsPart.split(',').map(Number),
      team === 'all' ? null : team,
    )
    if (!read.isCurrent()) return
    setAnswered(key)
    // A failed read keeps what is showing: an unreachable server is not news
    // that every routine stopped.
    if (view.ok) {
      setState({ key, routines: view.routines })
      if (view.timeZone) setTimeZone(view.timeZone)
    }
  }, [key, reads])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useVisiblePolling(() => void refresh(), 30_000, { enabled: key !== null })

  return {
    routines: state && state.key === key ? state.routines : NONE,
    settled: key === null || answered === key,
    timeZone,
    refresh,
  }
}
