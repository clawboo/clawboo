// Tiny relative-time formatter ("3m ago") built on the same native primitives as
// `formatTimestamp` (no moment / dayjs dependency). Used by the runtime
// diagnostics probe history + the fleet-health recent-issues list.

export function formatRelative(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms)
  const s = Math.floor(diff / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
