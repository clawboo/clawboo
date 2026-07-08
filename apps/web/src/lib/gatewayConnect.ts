/**
 * apps/web/src/lib/gatewayConnect.ts
 *
 * Shared "connect to the OpenClaw Gateway using saved settings" helper.
 *
 * This is the exact connect logic the onboarding wizard's `handleAllGood` used
 * inline (everything-is-green → auto-connect via the same-origin proxy). It is
 * extracted here so the wizard AND the dashboard's OpenClawSetupFlow drive the
 * SAME code path — no copy-paste divergence.
 *
 * Faithful to `handleAllGood`: it does NOT pass `authScopeKey` (the returning-
 * user auto-connect in GatewayBootstrap does, deliberately scoping device auth
 * by URL — that is a separate flow). Do not add it here or wizard reconnect
 * scoping changes silently.
 *
 * Connects via the same-origin proxy (`/api/gateway/ws`) rather than the raw
 * Gateway URL — upholds Architecture Invariant #2; the proxy injects the auth
 * token + device signature server-side.
 *
 * Throws on: no saved settings, an empty saved `gatewayUrl`, or a connect
 * failure (the `GatewayResponseError` — including `code === 'NOT_PAIRED'` —
 * propagates so callers can branch on it). Callers `catch` and fall back.
 */

import { GatewayClient, resolveProxyGatewayUrl } from '@clawboo/gateway-client'

export async function connectGatewayFromSettings(): Promise<{
  client: GatewayClient
  gatewayUrl: string
}> {
  const resp = await fetch('/api/settings')
  if (!resp.ok) {
    throw new Error('Could not read saved Gateway settings')
  }
  const data = (await resp.json()) as { gatewayUrl?: string }
  const gatewayUrl = data.gatewayUrl?.trim()
  if (!gatewayUrl) {
    throw new Error('No saved Gateway URL')
  }

  const client = new GatewayClient()
  await client.connect(resolveProxyGatewayUrl(), {
    clientName: 'openclaw-control-ui',
    clientVersion: '0.1.0',
    disableDeviceAuth: true,
  })

  return { client, gatewayUrl }
}
