/** The newest `seq` among the pause events in a tail of the event log, or 0. */
export function latestPauseEvent(events: ReadonlyArray<{ seq: number; kind: string }>): number {
  let seq = 0
  for (const e of events) {
    if (e.seq > seq && (e.kind === 'pause_placed' || e.kind === 'pause_lifted')) seq = e.seq
  }
  return seq
}
