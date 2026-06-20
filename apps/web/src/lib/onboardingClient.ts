// Defensive client for the onboarding seed endpoint (mirrors the runtimesClient
// pattern: best-effort, typed, never throws to the caller). Seeds a default
// native leader + specialist team after a provider key is connected.

export interface SeedResult {
  ok: boolean
  teamId?: string
  leaderAgentId?: string
  specialistAgentId?: string
  error?: string
}

/** POST /api/onboarding/seed-native-team — mint a starter native team. */
export async function seedNativeTeam(provider: string, model?: string): Promise<SeedResult> {
  try {
    const res = await fetch('/api/onboarding/seed-native-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { provider, model } : { provider }),
    })
    const body = (await res.json().catch(() => ({}))) as {
      teamId?: string
      leaderAgentId?: string
      specialistAgentId?: string
      error?: string
    }
    return { ok: res.ok && Boolean(body.teamId), ...body }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
