// Onboarding: the native leader-model pick. Onboarding creates no team of its
// own; the user picks one in the marketplace and deploys it (SelectTeamStep →
// CreateTeamModal). What the connect step does record is the provider + model
// chosen for the native leader, which the lazily-created Boo Zero and the team
// deploy both default to.

import type { Request, Response } from 'express'

import { envVarForProvider, KNOWN_PROVIDERS } from '@clawboo/adapter-native'
import { getSetting, setSetting, type ClawbooDb } from '@clawboo/db'

import { getDb } from '../lib/db'
import { loadAgentConfig, saveAgentConfig } from '../lib/runtimes/native/agentConfigStore'
import {
  readRecordedNativeDefault,
  resolveNativeTierDefaults,
} from '../lib/runtimes/native/nativeProviderDefaults'
import { SETTING_NATIVE_BOO_ZERO_ID, SETTING_NATIVE_LEADER_MODEL } from '../lib/teamChat/booZero'

interface LeaderModelBody {
  provider?: unknown
  model?: unknown
}

// POST /api/onboarding/native-leader-model — record the provider + model the user
// picked when connecting their native key, so the lazily-created universal Boo
// Zero (ensureNativeBooZero) runs on it instead of the auto-resolved per-provider
// default. `CreateTeamModal` reads it back as the default provider + model for the
// native agents of a team the user deploys.
export function onboardingNativeLeaderModelPOST(req: Request, res: Response): void {
  const body = (req.body ?? {}) as LeaderModelBody
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    res.status(400).json({ error: `unknown provider '${provider}'` })
    return
  }
  if (!model) {
    res.status(400).json({ error: 'model is required' })
    return
  }
  try {
    const db = getDb()
    setSetting(db, SETTING_NATIVE_LEADER_MODEL, JSON.stringify({ provider, model }))
    // Retro-apply to the EXISTING native Boo Zero so the pick takes effect
    // immediately — the setting alone only reaches a FUTURE lazily-created leader
    // (ensureNativeBooZero reads it at creation time). Best-effort: no Boo Zero
    // yet (fresh install mid-onboarding) is the normal case, not an error.
    try {
      const bzId = getSetting(db, SETTING_NATIVE_BOO_ZERO_ID)
      const cfg = bzId ? loadAgentConfig(db, bzId) : null
      if (bzId && cfg) {
        const envVar = envVarForProvider(provider)
        saveAgentConfig(db, {
          ...cfg,
          primaryProvider: provider,
          primaryModel: model,
          ...(envVar ? { envVar } : {}),
          updatedAt: Date.now(),
        })
      }
    } catch {
      /* best-effort */
    }
    res.status(200).json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}

/** The stored pick as written, or null/null when never set or unparseable. */
function readStoredLeaderModel(db: ClawbooDb): {
  provider: string | null
  model: string | null
} {
  try {
    const raw = getSetting(db, SETTING_NATIVE_LEADER_MODEL)
    if (!raw) return { provider: null, model: null }
    const parsed = JSON.parse(raw) as { provider?: string; model?: string }
    return { provider: parsed.provider ?? null, model: parsed.model ?? null }
  } catch {
    return { provider: null, model: null }
  }
}

// GET /api/onboarding/native-leader-model — the current default provider + model
// for the native leader (null/null when never set). Read by the Runtimes panel's
// native provider manager so its "Default" tag + model dropdown reflect reality.
// `resolved` is what an agent created without a model pick gets right now, per
// tier, from the same deploy path `createAgent` runs (pulled-model check
// included), or null when no native provider is set up. CreateTeamModal labels
// its "Default" rows with it, so the label can't promise a model the server won't
// use. A corrupt setting reads as no pick, and `resolved` still comes from the
// fixed order.
export async function onboardingNativeLeaderModelGET(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb()
    const resolved = await resolveNativeTierDefaults(readRecordedNativeDefault(db))
    res.json({ ...readStoredLeaderModel(db), resolved })
  } catch {
    res.json({ provider: null, model: null, resolved: null })
  }
}
