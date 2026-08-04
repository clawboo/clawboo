// Last-write-wins sequencing for a poll that overlaps itself.
//
// Every polling panel in the dashboard has more than one read in the air routinely:
// the interval fires again before the previous response landed, a Refresh button races
// the tick, and a mutation kicks a reconcile read. Applying each response as it arrives
// makes the view last-ARRIVAL-wins instead of last-REQUEST-wins, so an older snapshot
// can land last and revert newer state. Observed symptoms: a just-created card blanked,
// a committed drag snapped back to its old column, an optimistically-removed approval
// resurrected, a manual "Recheck" result reverted, and search-as-you-type results that
// contradict the filter box.
//
// TWO counters, because a read goes stale in two independent ways:
//
//   readId    A NEWER READ began. The older one must not write anything — not the data,
//             and not the loading chrome (clearing a spinner while a newer read is still
//             running, or dismissing a skeleton over the previous scope's data).
//
//   writeSeq  A LOCAL COMMIT landed after the read was issued, so the response predates
//             it and cannot possibly reflect it. This is NOT redundant with readId: a
//             local commit often starts no new read at all (a drag that PATCHes then
//             commits, an optimistic list removal), which leaves the in-flight read
//             still the newest and therefore invisible to readId alone.
//
// Usage — claim the token BEFORE the first await, so a commit made in the same tick as
// the call is already fenced off:
//
//   const reads = useReadSequencer()
//
//   const refresh = useCallback(async () => {
//     const read = reads.beginRead()
//     const data = await fetchThing()
//     if (!read.isCurrent()) return            // stale snapshot → drop it
//     setThing(data)
//     if (read.isNewestRead()) setLoaded(true) // loading chrome: newest read only
//   }, [reads])
//
//   // ...and at EVERY local write of the polled state:
//   reads.commitLocalWrite()
//   setThing((prev) => …)
//
// Dropping a stale response is safe: the poll re-reads within its interval, so the view
// converges on the next tick instead of flickering backwards on this one.
//
// `reads` is referentially stable, so adding it to a `useCallback`/`useEffect` dep array
// never re-creates a poll interval.

import { useMemo, useRef } from 'react'

/** A single read's claim on the right to write state. Obtained from `beginRead()`. */
export interface ReadToken {
  /**
   * No newer read has begun since this one. Gates the LOADING CHROME (spinner,
   * skeleton) — deliberately ignores local commits, because a commit does not mean a
   * newer read is coming, and gating chrome on it would strand a spinner until the
   * next poll tick.
   */
  isNewestRead(): boolean
  /**
   * No newer read began AND no local commit landed since this read was issued. Gates
   * the DATA. False ⇒ this response is a stale snapshot; return without writing.
   */
  isCurrent(): boolean
}

export interface ReadSequencer {
  /** Claim the next read id. Call synchronously, before the first `await`. */
  beginRead(): ReadToken
  /**
   * Fence off every read currently in flight, because state just changed locally
   * (an optimistic update, or a mutation committed into the polled state). Call it
   * immediately before the local `setState`.
   */
  commitLocalWrite(): void
}

export function useReadSequencer(): ReadSequencer {
  const readIdRef = useRef(0)
  const writeSeqRef = useRef(0)

  // Stable for the component's lifetime — refs are mutable, so nothing here needs to
  // change identity, and a stable object keeps callers' dep arrays honest and cheap.
  return useMemo(
    () => ({
      beginRead(): ReadToken {
        const readId = ++readIdRef.current
        const writeSeq = writeSeqRef.current
        const isNewestRead = (): boolean => readId === readIdRef.current
        return {
          isNewestRead,
          isCurrent: () => isNewestRead() && writeSeq === writeSeqRef.current,
        }
      },
      commitLocalWrite(): void {
        writeSeqRef.current += 1
      },
    }),
    [],
  )
}
