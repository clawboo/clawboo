// The OpenClaw Gateway's DEFAULT model (`openclaw.json` →
// `agents.defaults.model.primary`) — the model an OpenClaw agent runs on when it
// has no per-agent override.
//
// OpenClaw's model lives Gateway-side, not in clawboo's registry (see
// `AgentRecord.model` — "omitted for sources whose model lives elsewhere"), so
// `agent.model` is null for OpenClaw agents in thin-client / native mode. Two
// surfaces need this default to show the EFFECTIVE model instead of a "Gateway
// model" placeholder:
//   - the agent-detail model control ("Default (Claude Sonnet 4.5)"), and
//   - the Ghost Graph / MiniGraph model orbital.
// Sharing one fetch keeps them consistent (they must agree for the same agent).

import { useEffect, useState } from 'react'

/**
 * Reads the OpenClaw default model from `/api/system/openclaw-config`.
 * Non-fatal — returns null on any failure (no config, disconnected, non-2xx),
 * in which case the graph falls back to the neutral "Gateway model" label.
 */
export async function fetchOpenclawDefaultModel(): Promise<string | null> {
  try {
    const res = await fetch('/api/system/openclaw-config')
    const data = (await res.json()) as {
      config?: { agents?: { defaults?: { model?: { primary?: string } } } }
    }
    return data?.config?.agents?.defaults?.model?.primary ?? null
  } catch {
    return null
  }
}

/** Hook wrapper — fetches once on mount. */
export function useOpenclawDefaultModel(): string | null {
  const [model, setModel] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void fetchOpenclawDefaultModel().then((m) => {
      if (alive) setModel(m)
    })
    return () => {
      alive = false
    }
  }, [])
  return model
}
