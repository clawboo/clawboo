/**
 * Fetches the per-agent exec config map from SQLite via the API.
 * Returns a Map of agentId → { execAsk }. Returns empty map on failure.
 */
export async function fetchExecConfigMap(): Promise<Map<string, { execAsk: string }>> {
  const map = new Map<string, { execAsk: string }>()
  try {
    const res = await fetch('/api/exec-settings/all')
    const data = (await res.json()) as {
      configs?: Record<string, { execAsk: string }>
    }
    if (data.configs) {
      for (const [id, cfg] of Object.entries(data.configs)) {
        if (cfg && typeof cfg.execAsk === 'string') {
          map.set(id, { execAsk: cfg.execAsk })
        }
      }
    }
  } catch {
    // Non-fatal — agents just won't have exec config overrides
  }
  return map
}
