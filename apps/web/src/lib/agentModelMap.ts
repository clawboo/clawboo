/**
 * Fetches the per-agent model map from openclaw.json via the API.
 * Returns a Map of agentId → model string. Returns empty map on failure.
 */
export async function fetchAgentModelMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const res = await fetch('/api/system/openclaw-config')
    const data = (await res.json()) as {
      config?: {
        agents?: {
          list?: Array<{ id: string; model?: string | { primary?: string } }>
        }
      }
    }
    const list = data?.config?.agents?.list
    if (!Array.isArray(list)) return map
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string') continue
      const model =
        typeof entry.model === 'string'
          ? entry.model
          : typeof entry.model === 'object' && entry.model?.primary
            ? entry.model.primary
            : null
      if (model) map.set(entry.id, model)
    }
  } catch {
    // Non-fatal — agents just won't have model overrides
  }
  return map
}
