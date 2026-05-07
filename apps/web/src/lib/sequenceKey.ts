// Process-local strictly-increasing counter for transcript ordering.
//
// Background: every `TranscriptEntry` carries a `timestampMs` (wall-clock time
// in ms) AND a `sequenceKey` (intended as a tiebreaker). The merged group-chat
// view sorts by `(timestampMs, sequenceKey)`, but historically every code path
// initialised both fields to the same `Date.now()` value — so the secondary
// key never broke ties, and entries that landed in the same millisecond ended
// up in undefined order (effectively whatever insertion order the JS engine's
// sort produced).
//
// Calling `nextSeq()` at every entry-creation site guarantees the secondary
// key is strictly increasing, so the sort comparator always has a real
// tiebreak to fall back on. The counter is process-local; on page refresh
// transcript history is reloaded from SQLite with timestamps far enough apart
// that the counter is irrelevant for replayed history.

let counter = 0

export function nextSeq(): number {
  return ++counter
}

/** Reset the counter — for test isolation only. Do not call in production. */
export function _resetSeqForTest(): void {
  counter = 0
}
