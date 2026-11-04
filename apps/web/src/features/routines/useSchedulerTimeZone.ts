// The zone routines are worked out in, read when the routine form opens and
// changed from it. Null until the server answers (and when it cannot), in which
// case the form previews in the browser's own zone.

import { useCallback, useEffect, useState } from 'react'

import {
  fetchSchedulerTimeZone,
  saveSchedulerTimeZone,
  type ScheduleActionResult,
  type SchedulerTimeZone,
} from '@/lib/schedulesClient'

export function useSchedulerTimeZone(): {
  zone: SchedulerTimeZone | null
  /** Store a zone (null follows the server's own again). */
  save: (timeZone: string | null) => Promise<ScheduleActionResult>
} {
  const [zone, setZone] = useState<SchedulerTimeZone | null>(null)

  useEffect(() => {
    let live = true
    void fetchSchedulerTimeZone().then((z) => {
      if (live && z) setZone(z)
    })
    return () => {
      live = false
    }
  }, [])

  const save = useCallback(async (timeZone: string | null): Promise<ScheduleActionResult> => {
    const result = await saveSchedulerTimeZone(timeZone)
    if (result.ok && result.value) setZone(result.value)
    return result
  }, [])

  return { zone, save }
}
