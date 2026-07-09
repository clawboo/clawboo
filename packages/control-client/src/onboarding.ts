// Defensive client for the onboarding endpoints (best-effort, typed, never throws
// to the caller). Seeds a default native team, and reads the aggregated
// onboarding state so a thin client decides wizard-vs-dashboard in one call.

import { apiFetch } from './config'

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
    const res = await apiFetch('/api/onboarding/seed-native-team', {
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

/** The aggregated first-run signals — the inputs a client feeds into its
 *  wizard-vs-dashboard decision, computed server-side so thin clients skip the
 *  multi-call dance (system status + teams + agents + runtimes). */
export interface OnboardingState {
  /** OpenClaw installed AND its config + env files exist. */
  configured: boolean
  /** ≥1 clawboo-native agent exists. */
  hasNative: boolean
  /** ≥1 team exists. */
  hasTeam: boolean
  /** ≥1 connectable runtime has a stored credential. */
  hasConnectedRuntime: boolean
}

/** GET /api/onboarding/state — the aggregated first-run signals in one call.
 *  Defensive: reports the "fresh install" (all-false) shape on any error. */
export async function fetchOnboardingState(): Promise<OnboardingState> {
  try {
    const res = await apiFetch('/api/onboarding/state')
    if (!res.ok) return { configured: false, hasNative: false, hasTeam: false, hasConnectedRuntime: false }
    const body = (await res.json()) as Partial<OnboardingState>
    return {
      configured: body.configured === true,
      hasNative: body.hasNative === true,
      hasTeam: body.hasTeam === true,
      hasConnectedRuntime: body.hasConnectedRuntime === true,
    }
  } catch {
    return { configured: false, hasNative: false, hasTeam: false, hasConnectedRuntime: false }
  }
}
