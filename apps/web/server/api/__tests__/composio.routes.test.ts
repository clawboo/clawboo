// The broker's REST surface.
//
// The property that matters most here is what does NOT come back: the key is
// written to the vault and every response says only whether one exists. The
// rest is about not repeating the loop that made this rebuild necessary, where
// authorizing an already-connected app minted a second consent flow and sent
// the operator back to the provider for nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  hasKey: false,
  connected: new Set<string>(),
  known: false,
  /** What Composio says about the key when the route checks it. */
  verdict: 'ok' as 'ok' | 'rejected' | 'unreachable',
  authorize: vi.fn(),
  stored: vi.fn(),
}

vi.mock('../../lib/connectors/composio', () => ({
  hasComposioKey: () => state.hasKey,
  setComposioKey: vi.fn((key: string) => {
    state.stored(key)
    state.hasKey = true
  }),
  clearComposioKey: vi.fn(() => {
    state.hasKey = false
  }),
  connectedAppsNow: () => ({ connected: state.connected, known: state.known }),
  refreshConnectedApps: vi.fn(async () => {}),
  invalidateConnectedApps: vi.fn(),
  authorizeApp: (...a: unknown[]) => state.authorize(...a),
  verifyComposioKey: vi.fn(async () => state.verdict),
  composioKeyVerdict: () => (state.hasKey ? state.verdict : null),
  noteComposioKeyVerdict: vi.fn(),
}))

import {
  composioAuthorizePOST,
  composioKeyDELETE,
  composioKeyPUT,
  composioStatusGET,
} from '../composio'

function res() {
  const out: { status: number; body: unknown } = { status: 200, body: null }
  const r = {
    status(code: number) {
      out.status = code
      return r
    },
    json(body: unknown) {
      out.body = body
      return r
    },
  }
  return { r: r as never, out }
}

describe('composio routes', () => {
  beforeEach(() => {
    state.hasKey = false
    state.connected = new Set()
    state.known = false
    state.verdict = 'ok'
    state.authorize.mockReset()
    state.stored.mockReset()
  })

  it('reports only whether a key exists, never the key', async () => {
    const { r, out } = res()
    await composioStatusGET({} as never, r)
    expect(out.body).toEqual({ ok: true, hasKey: false, known: true, connected: [] })
    expect(JSON.stringify(out.body)).not.toMatch(/ak_|apiKey/)
  })

  it('maps broker toolkit names back to clawboo slugs', async () => {
    state.hasKey = true
    state.known = true
    // The broker's name for Google Calendar is `googlecalendar`, not our slug.
    state.connected = new Set(['gmail', 'googlecalendar'])
    const { r, out } = res()
    await composioStatusGET({} as never, r)
    expect((out.body as { connected: string[] }).connected.sort()).toEqual([
      'gmail',
      'google-calendar',
    ])
  })

  it('stores a pasted key and answers with a boolean', async () => {
    const { r, out } = res()
    await composioKeyPUT({ body: { apiKey: 'ak_test_1234567890' } } as never, r)
    expect(out.body).toEqual({ ok: true, hasKey: true, verified: true })
    expect(JSON.stringify(out.body)).not.toContain('ak_test')
  })

  it('takes the key out of the line the dashboard shows', async () => {
    // The paste that shipped broken: the value arrived wrapped in its own
    // variable name and was stored verbatim, so every later call was refused.
    const { r } = res()
    await composioKeyPUT({ body: { apiKey: 'COMPOSIO_API_KEY=ak_test_1234567890' } } as never, r)
    expect(state.stored).toHaveBeenCalledWith('ak_test_1234567890')
  })

  it('refuses a key too short to be one', async () => {
    const { r, out } = res()
    await composioKeyPUT({ body: { apiKey: 'short' } } as never, r)
    expect(out.status).toBe(400)
  })

  it('does not store a key Composio refuses', async () => {
    state.verdict = 'rejected'
    const { r, out } = res()
    await composioKeyPUT({ body: { apiKey: 'ak_test_1234567890' } } as never, r)
    expect(out.status).toBe(400)
    expect(state.stored).not.toHaveBeenCalled()
    expect(state.hasKey).toBe(false)
  })

  it('keeps a key it could not check, and says so', async () => {
    // A laptop with no network must not be told its good key was refused.
    state.verdict = 'unreachable'
    const { r, out } = res()
    await composioKeyPUT({ body: { apiKey: 'ak_test_1234567890' } } as never, r)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, hasKey: true, verified: false })
  })

  it('tells the shelf when a stored key is being refused', async () => {
    state.hasKey = true
    state.known = true
    state.verdict = 'rejected'
    const { r, out } = res()
    await composioStatusGET({} as never, r)
    expect((out.body as { keyRejected: boolean }).keyRejected).toBe(true)
  })

  it('forgets a key on request', () => {
    state.hasKey = true
    const { r, out } = res()
    composioKeyDELETE({} as never, r)
    expect(out.body).toEqual({ ok: true, hasKey: false })
  })

  it('does not authorize without a key', async () => {
    const { r, out } = res()
    await composioAuthorizePOST({ params: { slug: 'gmail' } } as never, r)
    expect(out.status).toBe(409)
    expect(state.authorize).not.toHaveBeenCalled()
  })

  it('never re-authorizes an app that is already connected', async () => {
    // The whole loop, in one assertion: pressing Connect on a connected app
    // used to mint a fresh consent link and march the operator back to Google.
    state.hasKey = true
    state.known = true
    state.connected = new Set(['gmail'])
    const { r, out } = res()
    await composioAuthorizePOST({ params: { slug: 'gmail' } } as never, r)
    expect(out.body).toEqual({ ok: true, alreadyConnected: true })
    expect(state.authorize).not.toHaveBeenCalled()
  })

  it('authorizes with the BROKER name, not our slug', async () => {
    state.hasKey = true
    state.known = true
    state.authorize.mockResolvedValue({ ok: true, data: { redirectUrl: 'https://x.test/l' } })
    const { r, out } = res()
    await composioAuthorizePOST({ params: { slug: 'google-calendar' } } as never, r)
    expect(state.authorize).toHaveBeenCalledWith('googlecalendar', expect.any(String))
    expect(out.body).toEqual({ ok: true, url: 'https://x.test/l' })
  })

  it('404s an app the catalog does not have', async () => {
    state.hasKey = true
    const { r, out } = res()
    await composioAuthorizePOST({ params: { slug: 'not-an-app' } } as never, r)
    expect(out.status).toBe(404)
  })

  it('treats a link with no url as a failure, not a connection', async () => {
    // The broker's own type allows a null redirect. Answering ok with no url is
    // indistinguishable to the shelf from "already connected", so it ticked the
    // app as linked when nothing had been authorised.
    state.hasKey = true
    state.known = true
    state.authorize.mockResolvedValue({ ok: true, data: { redirectUrl: null } })
    const { r, out } = res()
    await composioAuthorizePOST({ params: { slug: 'gmail' } } as never, r)
    expect(out.status).toBe(502)
    expect(out.body).not.toMatchObject({ ok: true })
  })
})
