// ─── Provider keys REST ──────────────────────────────────────────────────────
// The Settings → Providers hub. Manages provider API keys across BOTH stores (the
// encrypted vault + OpenClaw's `.env`) via `lib/providerKeys`. A key VALUE is never
// echoed back — responses carry only per-provider connection status.

import type { Request, Response } from 'express'

import {
  connectProviderKey,
  disconnectProviderKey,
  isKnownProvider,
  providerStatus,
} from '../lib/providerKeys'
import { envVarForOpenclawProvider } from '../lib/openclawEnv'
import { resolveRuntimeKey } from '../lib/secretsVault'
import { fetchNativeModelsForKey, hasLiveModels } from '../lib/providerModels'

// GET /api/providers → { providers: [{ id, connected, poweredRuntimes }] }
export function providersListGET(_req: Request, res: Response): void {
  res.json({ providers: providerStatus() })
}

// POST /api/providers/:id/connect { apiKey } → stores the key in both stores.
export function providerConnectPOST(req: Request, res: Response): void {
  const id = String(req.params['id'] ?? '')
  if (!isKnownProvider(id)) {
    res.status(400).json({ error: `unknown provider '${id}'` })
    return
  }
  const body = (req.body ?? {}) as { apiKey?: unknown }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey) {
    res.status(400).json({ error: 'apiKey is required' })
    return
  }
  connectProviderKey(id, apiKey)
  res.json({ ok: true, providers: providerStatus() })
}

// POST /api/providers/:id/disconnect → clears the key from both stores.
export function providerDisconnectPOST(req: Request, res: Response): void {
  const id = String(req.params['id'] ?? '')
  if (!isKnownProvider(id)) {
    res.status(400).json({ error: `unknown provider '${id}'` })
    return
  }
  disconnectProviderKey(id)
  res.json({ ok: true, providers: providerStatus() })
}

// GET /api/providers/:id/models → the provider's LIVE model list, enumerated with
// the stored (vault / OpenClaw .env) key. `[]` for a keyless / unsupported provider
// (the client falls back to its static list). Only anthropic + openai enumerate here.
export async function providerModelsGET(req: Request, res: Response): Promise<void> {
  const id = String(req.params['id'] ?? '')
  if (!hasLiveModels(id)) {
    res.json({ models: [] })
    return
  }
  const key = resolveRuntimeKey(envVarForOpenclawProvider(id))
  const models = key ? await fetchNativeModelsForKey(id, key) : []
  res.json({ models })
}

// POST /api/providers/:id/models { apiKey } → the LIVE model list using a PASTED
// (unsaved) key — for the onboarding step, before any key is stored. The key is
// used for one fetch only: never logged, persisted, or echoed.
export async function providerModelsPOST(req: Request, res: Response): Promise<void> {
  const id = String(req.params['id'] ?? '')
  const body = (req.body ?? {}) as { apiKey?: unknown }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!hasLiveModels(id) || !apiKey) {
    res.json({ models: [] })
    return
  }
  res.json({ models: await fetchNativeModelsForKey(id, apiKey) })
}
