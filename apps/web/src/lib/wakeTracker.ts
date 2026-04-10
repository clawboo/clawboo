// Wake Tracker — localStorage-persisted per-agent wake records.
// Tracks which agents have been woken for group chat, with 4 AM daily invalidation.
// Survives page refreshes so agents aren't re-woken unnecessarily (saves model API costs).

const STORAGE_KEY = 'clawboo:wake-records'
const PRUNE_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

// ─── Types ───────────────────────────────────────────────────────────────────

interface WakeRecord {
  wokeAt: number // epoch ms
}

interface WakeStore {
  records: Record<string, WakeRecord> // key: `${teamId}:${agentId}`
  lastPruneAt: number
}

// ─── Internal ────────────────────────────────────────────────────────────────

function makeKey(agentId: string, teamId: string): string {
  return `${teamId}:${agentId}`
}

function emptyStore(): WakeStore {
  return { records: {}, lastPruneAt: Date.now() }
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function load(): WakeStore {
  try {
    const storage = getStorage()
    if (!storage) return emptyStore()
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as WakeStore
    if (!parsed || typeof parsed.records !== 'object') return emptyStore()
    return maybePrune(parsed)
  } catch {
    return emptyStore()
  }
}

function save(store: WakeStore): void {
  try {
    const storage = getStorage()
    if (!storage) return
    storage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

function maybePrune(store: WakeStore): WakeStore {
  const now = Date.now()
  if (now - store.lastPruneAt < PRUNE_INTERVAL_MS) return store

  const cutoff = now - MAX_RECORD_AGE_MS
  const pruned: Record<string, WakeRecord> = {}
  for (const [key, record] of Object.entries(store.records)) {
    if (record.wokeAt > cutoff) {
      pruned[key] = record
    }
  }
  return { records: pruned, lastPruneAt: now }
}

/**
 * Compute the most recent 4 AM boundary (local time).
 * If it's currently before 4 AM, the boundary is yesterday's 4 AM.
 */
function getMostRecent4AM(): number {
  const now = new Date()
  const boundary = new Date(now)
  boundary.setHours(4, 0, 0, 0)
  if (now < boundary) {
    boundary.setDate(boundary.getDate() - 1)
  }
  return boundary.getTime()
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Check if an agent is currently awake for a given team (woken after last 4 AM). */
export function isAgentAwake(agentId: string, teamId: string): boolean {
  const store = load()
  const record = store.records[makeKey(agentId, teamId)]
  if (!record) return false
  return record.wokeAt > getMostRecent4AM()
}

/** Mark an agent as successfully woken for a given team. */
export function markAgentAwake(agentId: string, teamId: string): void {
  const store = load()
  store.records[makeKey(agentId, teamId)] = { wokeAt: Date.now() }
  save(store)
}

/** Batch check: returns agent IDs that are NOT awake (need waking). */
export function findSleepingAgents(agentIds: string[], teamId: string): string[] {
  const store = load()
  const boundary = getMostRecent4AM()
  return agentIds.filter((id) => {
    const record = store.records[makeKey(id, teamId)]
    return !record || record.wokeAt <= boundary
  })
}

/** Clear all wake records. Called on Gateway disconnect. */
export function clearAllWakeRecords(): void {
  try {
    getStorage()?.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** Clear records for a specific team. */
export function clearTeamWakeRecords(teamId: string): void {
  const store = load()
  const prefix = `${teamId}:`
  const filtered: Record<string, WakeRecord> = {}
  for (const [key, record] of Object.entries(store.records)) {
    if (!key.startsWith(prefix)) {
      filtered[key] = record
    }
  }
  store.records = filtered
  save(store)
}

/** Reset everything — exposed for testing. */
export function _resetForTest(): void {
  clearAllWakeRecords()
}
