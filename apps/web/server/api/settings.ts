import type { Request, Response } from 'express'
import { loadSettings, saveSettings } from '@clawboo/config'

// GET /api/settings — returns current persisted settings.
// The token is included so the browser GatewayClient can authenticate
// directly (device auth signs the token into its Ed25519 payload).
// This endpoint is same-origin only (no CORS in prod) and protected by the
// access gate when STUDIO_ACCESS_TOKEN is set, so exposure is limited
// to the local user's browser session.
export function settingsGET(_req: Request, res: Response): void {
  try {
    const settings = loadSettings()
    res.json({
      gatewayUrl: settings.gatewayUrl,
      gatewayToken: settings.gatewayToken || '',
      hasToken: Boolean(settings.gatewayToken),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load settings'
    res.status(500).json({ error: message })
  }
}

// POST /api/settings — persists gateway URL and token
// Only fields present in the request body are updated; omitted fields are left unchanged.
export function settingsPOST(req: Request, res: Response): void {
  try {
    const body = req.body as { gatewayUrl?: string; gatewayToken?: string } | undefined
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'JSON body required' })
      return
    }
    saveSettings({
      gatewayUrl: body.gatewayUrl ?? '',
      // Only persist the token if the caller explicitly provided it.
      // Omitting gatewayToken from the body means "keep existing token".
      ...('gatewayToken' in body ? { gatewayToken: body.gatewayToken ?? '' } : {}),
    })
    res.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save settings'
    res.status(500).json({ error: message })
  }
}
