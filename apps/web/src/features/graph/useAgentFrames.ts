// Which agents have a browser frame to show, and how fresh each one is.
//
// The dock opens onto whichever agent the graph happened to list first, and on
// a fleet where one agent browses and three do not, that is an empty panel four
// times out of five. This turns the chip row into a signal — a dot on the ones
// that have something — and lets the dock open on the freshest frame instead of
// the alphabetically luckiest agent.
//
// Only the METADATA is fetched (`?meta=1`), never the image: this runs for
// every agent on the graph, and pulling N screenshots to decide which one to
// show would cost megabytes to answer a question about timestamps.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@clawboo/control-client'

import { useVisiblePolling } from '@/lib/useVisiblePolling'

/** Matches the dock's own cadence: a frame that lands mid-run shows up within
 *  a few seconds without either surface hammering the route. */
const POLL_MS = 4_000

/** agentId → capture time of its newest frame, or null if it has none. */
export type FrameIndex = ReadonlyMap<string, number | null>

export function useAgentFrames(agentIds: readonly string[], enabled: boolean): FrameIndex {
  const [frames, setFrames] = useState<Map<string, number | null>>(new Map())
  // Sorted so a re-ordered list of the same agents does not re-fire the probe.
  const key = [...agentIds].sort().join(',')

  const probe = useCallback(() => {
    if (!enabled || agentIds.length === 0) return
    let cancelled = false
    void Promise.all(
      agentIds.map(async (id) => {
        try {
          const r = await apiFetch(`/api/agents/${encodeURIComponent(id)}/screenshot?meta=1`)
          if (!r.ok) return [id, null] as const
          const body = (await r.json()) as { ts?: number }
          return [id, typeof body.ts === 'number' ? body.ts : null] as const
        } catch {
          return [id, null] as const
        }
      }),
    ).then((pairs) => {
      if (cancelled) return
      setFrames((prev) => {
        // Replace only when something actually changed, so the chip row does
        // not re-render on every tick of a poll that found nothing new.
        if (prev.size === pairs.length && pairs.every(([id, ts]) => prev.get(id) === ts))
          return prev
        return new Map(pairs)
      })
    })
    return () => {
      cancelled = true
    }
    // `key` stands in for the id set: agentIds is a new array every render, so
    // depending on it directly would re-fire the probe on every parent render.
  }, [key, enabled])

  useEffect(() => {
    if (!enabled) {
      setFrames(new Map())
      return
    }
    probe()
  }, [probe, enabled])

  useVisiblePolling(probe, POLL_MS)

  return frames
}

/** The agent whose frame is newest, or null when nobody has one. */
export function freshestAgent(frames: FrameIndex): string | null {
  let bestId: string | null = null
  let bestTs = -Infinity
  for (const [id, ts] of frames) {
    if (ts !== null && ts > bestTs) {
      bestTs = ts
      bestId = id
    }
  }
  return bestId
}
