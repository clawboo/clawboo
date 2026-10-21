import { useState } from 'react'

import { useVisiblePolling } from '@/lib/useVisiblePolling'

/**
 * The current time for the calendar, refreshed every 30 seconds and whenever
 * the tab comes back into view, so "today", the remaining runs of today and the
 * Today button all roll over at midnight without a reload.
 */
export function useCalendarClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useVisiblePolling(() => setNow(Date.now()), 30_000)
  return now
}
