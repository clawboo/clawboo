import { NextResponse } from 'next/server'
import { loadSettings, saveSettings } from '@clawboo/config'

// GET /api/settings — returns current persisted settings.
// The token is included so the browser GatewayClient can authenticate
// directly (device auth signs the token into its Ed25519 payload).
// This endpoint is same-origin only (no CORS) and protected by the
// access gate when STUDIO_ACCESS_TOKEN is set, so exposure is limited
// to the local user's browser session.
export async function GET() {
  try {
    const settings = loadSettings()
    return NextResponse.json({
      gatewayUrl: settings.gatewayUrl,
      gatewayToken: settings.gatewayToken || '',
      hasToken: Boolean(settings.gatewayToken),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load settings'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST /api/settings — persists gateway URL and token
// Only fields present in the request body are updated; omitted fields are left unchanged.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { gatewayUrl?: string; gatewayToken?: string }
    saveSettings({
      gatewayUrl: body.gatewayUrl ?? '',
      // Only persist the token if the caller explicitly provided it.
      // Omitting gatewayToken from the body means "keep existing token".
      ...('gatewayToken' in body ? { gatewayToken: body.gatewayToken ?? '' } : {}),
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save settings'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
