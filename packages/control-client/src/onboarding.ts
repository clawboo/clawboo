// Defensive client for the onboarding endpoints (best-effort, typed, never throws
// to the caller). Reads and records the native leader-model pick, and reads the
// aggregated onboarding state so a thin client decides wizard-vs-dashboard in one
// call.

import { apiFetch } from './config'

/** One tier's auto-resolved native provider + model. */
export interface NativeTierDefault {
  provider: string
  model: string
}

/** What a native agent created without a model pick gets, per tier. */
export interface NativeTierDefaults {
  leader: NativeTierDefault
  specialist: NativeTierDefault
}

/** The native leader's current default provider + model (null/null = never set). */
export interface NativeLeaderModel {
  provider: string | null
  model: string | null
  /** What an agent deployed without a model pick actually gets right now, per
   *  tier (the server's own resolver), or null when no native provider is set up. */
  resolved: NativeTierDefaults | null
}

function parseTierDefault(v: unknown): NativeTierDefault | null {
  if (!v || typeof v !== 'object') return null
  const { provider, model } = v as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return null
  return { provider, model }
}

function parseTierDefaults(v: unknown): NativeTierDefaults | null {
  if (!v || typeof v !== 'object') return null
  const { leader, specialist } = v as { leader?: unknown; specialist?: unknown }
  const l = parseTierDefault(leader)
  const s = parseTierDefault(specialist)
  return l && s ? { leader: l, specialist: s } : null
}

/** GET /api/onboarding/native-leader-model — the current default. Defensive:
 *  null/null on any error (callers render "no default yet"). */
export async function fetchNativeLeaderModel(): Promise<NativeLeaderModel> {
  try {
    const res = await apiFetch('/api/onboarding/native-leader-model')
    if (!res.ok) return { provider: null, model: null, resolved: null }
    const body = (await res.json()) as {
      provider?: string | null
      model?: string | null
      resolved?: unknown
    }
    return {
      provider: body.provider ?? null,
      model: body.model ?? null,
      resolved: parseTierDefaults(body.resolved),
    }
  } catch {
    return { provider: null, model: null, resolved: null }
  }
}

/** POST /api/onboarding/native-leader-model — record the provider + model the
 *  user picked when connecting a native key, so the universal Boo Zero runs on
 *  it (retro-applied to an existing native Boo Zero server-side). Best-effort
 *  (a failure just falls back to the per-provider default). */
export async function setNativeLeaderModel(provider: string, model: string): Promise<boolean> {
  try {
    const res = await apiFetch('/api/onboarding/native-leader-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    })
    return res.ok
  } catch {
    return false
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
    if (!res.ok)
      return { configured: false, hasNative: false, hasTeam: false, hasConnectedRuntime: false }
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
