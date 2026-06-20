import type { Request, Response } from 'express'
import { loadSettings, saveSettings, type ClawbooSettings } from '@clawboo/config'

import { getRegistry } from '../lib/agentSource'

// A persisted gatewayUrl is later dialed by the same-origin proxy
// (`new WebSocket(upstreamUrl)`). Require a websocket scheme so an arbitrary
// (e.g. http/file/javascript) target can't be stored and dialed by the server.
// Host is intentionally NOT restricted — a remote gateway is a supported choice.
function isValidGatewayUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'ws:' || u.protocol === 'wss:'
  } catch {
    return false
  }
}

// GET /api/settings — returns current persisted settings.
// The raw gateway token is NEVER returned: the browser doesn't need it (the
// same-origin proxy injects the upstream token server-side), so we expose only
// `hasToken`. Returning the credential here would leak it to anyone who can
// reach the endpoint (the default bind is loopback, but a leaked secret in a
// response body is a defense-in-depth failure regardless of the bind).
export function settingsGET(_req: Request, res: Response): void {
  try {
    const settings = loadSettings()
    res.json({
      gatewayUrl: settings.gatewayUrl,
      hasToken: Boolean(settings.gatewayToken),
      firstRunDismissedAt: settings.firstRunDismissedAt ?? null,
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
    const body = req.body as
      | { gatewayUrl?: string; gatewayToken?: string; firstRunDismissedAt?: number }
      | undefined
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'JSON body required' })
      return
    }
    // Only persist fields the caller explicitly provided — an omitted field is
    // left unchanged (e.g. a dismiss-only POST must not clear the gateway URL).
    const update: Partial<ClawbooSettings> = {}
    // Type-guard every field before persisting (matches firstRunDismissedAt + the
    // reader-side discipline in loadSettings): an unvalidated body could carry a
    // number/null where a string is typed, which would either throw on `.trim()`
    // (gatewayUrl) or JSON-serialize a non-string into a string setting (token).
    if ('gatewayUrl' in body && typeof body.gatewayUrl === 'string') {
      const raw = body.gatewayUrl.trim()
      if (raw && !isValidGatewayUrl(raw)) {
        res.status(400).json({ error: 'gatewayUrl must be a ws:// or wss:// URL' })
        return
      }
      update.gatewayUrl = body.gatewayUrl
    }
    if ('gatewayToken' in body && typeof body.gatewayToken === 'string')
      update.gatewayToken = body.gatewayToken
    if ('firstRunDismissedAt' in body && typeof body.firstRunDismissedAt === 'number') {
      update.firstRunDismissedAt = body.firstRunDismissedAt
    }
    saveSettings(update)
    // Reconnect the server-side AgentSource only when the gateway URL/token was
    // actually updated (best-effort, non-blocking) — not on a dismiss-only POST
    // and not when a present-but-wrong-type field was skipped above.
    if ('gatewayUrl' in update || 'gatewayToken' in update) {
      void getRegistry()
        .reconnect()
        .catch(() => {})
    }
    res.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save settings'
    res.status(500).json({ error: message })
  }
}
