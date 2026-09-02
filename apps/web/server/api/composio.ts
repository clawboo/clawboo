// The broker's own REST surface: one key, one status read, one authorize.
//
// SEPARATE FILE, because this is not a connector API. The connectors routes are
// about servers clawboo spawns or dials and holds sessions to; these are about
// an account at a third party and which of its apps the operator has linked.
// The previous attempt put brokered apps through the connector routes and every
// one of them then needed a branch explaining that this kind of connector could
// not be connected.

import type { Request, Response } from 'express'

import { BROKERED_APPS, BROKERED_TOOLKITS, appForToolkit } from '@clawboo/connector-catalog'

import {
  authorizeApp,
  clearComposioKey,
  composioKeyVerdict,
  connectedAppsNow,
  hasComposioKey,
  invalidateConnectedApps,
  noteComposioKeyVerdict,
  refreshConnectedApps,
  setComposioKey,
  verifyComposioKey,
} from '../lib/connectors/composio'
import { explainKeyProblem, readComposioKey } from '../lib/connectors/composioKey'
import { redactValue } from '../lib/redact'

/** One user id per install. The broker scopes connections by it. */
const LOCAL_USER = 'clawboo-local'

/** The raw paste, bounded, before anything tries to make sense of it. */
function readBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const value = (body as { apiKey?: unknown }).apiKey
  if (typeof value !== 'string') return null
  return value.length <= 512 ? value : null
}

// GET /api/connectors/composio
//
// Whether a key is stored, and which apps are linked. The key itself never
// appears: `hasKey` is a boolean and that is the whole of what leaves here.
export async function composioStatusGET(_req: Request, res: Response): Promise<void> {
  try {
    const hasKey = hasComposioKey()
    if (!hasKey) {
      res.json({ ok: true, hasKey: false, known: true, connected: [] })
      return
    }
    // Waits at most for one refresh, and only when the cache is stale. Every
    // other reader takes the cached answer without blocking.
    await refreshConnectedApps(BROKERED_TOOLKITS)
    const { connected, known } = connectedAppsNow()
    const slugs = [...connected].map((t) => appForToolkit(t)?.slug).filter((s): s is string => !!s)

    // THE REFUSAL TRAVELS WITH THE ANSWER. Without it a rejected key and an
    // account with nothing connected yet are the same response, and the band
    // renders the encouraging one of the two.
    res.json({
      ok: true,
      hasKey: true,
      known,
      connected: slugs,
      keyRejected: composioKeyVerdict() === 'rejected',
    })
  } catch (err) {
    res.status(502).json({ error: `Could not read connected apps. ${safe(err)}` })
  }
}

// PUT /api/connectors/composio/key
//
// CHECKED BEFORE IT IS TRUSTED. The key is read out of whatever was pasted, then
// tried against Composio, and only a key that survives both is stored. Saving
// first and discovering later is what produced a screen reporting a saved key
// while every call behind it was being refused.
export async function composioKeyPUT(req: Request, res: Response): Promise<void> {
  try {
    const pasted = readBody(req.body)
    if (pasted === null) {
      res.status(400).json({ error: 'invalid body' })
      return
    }

    const { key, problem } = readComposioKey(pasted)
    if (!key) {
      res.status(400).json({ error: explainKeyProblem(problem ?? 'unrecognised') })
      return
    }

    const verdict = await verifyComposioKey(key)
    if (verdict === 'rejected') {
      // NOT STORED. A key Composio refuses is worth less than no key: it makes
      // the band look ready and fails on every press.
      res.status(400).json({
        error: 'Composio rejected that key. Copy it again from your project settings.',
      })
      return
    }

    setComposioKey(key)
    // The previous key's answers describe a different account.
    invalidateConnectedApps()
    noteComposioKeyVerdict(verdict)

    // UNREACHABLE IS SAVED AND SAID SO. The key is probably fine and the network
    // is not, so refusing it would be wrong; claiming it works would be a guess.
    res.json({ ok: true, hasKey: true, verified: verdict === 'ok' })
  } catch (err) {
    res.status(500).json({ error: safe(err) })
  }
}

// DELETE /api/connectors/composio/key
export function composioKeyDELETE(_req: Request, res: Response): void {
  try {
    clearComposioKey()
    invalidateConnectedApps()
    res.json({ ok: true, hasKey: false })
  } catch (err) {
    res.status(500).json({ error: safe(err) })
  }
}

// POST /api/connectors/composio/apps/:slug/authorize
//
// Start linking one app. Returns the broker's hosted consent URL for the
// browser to open; the provider's tokens are exchanged there and never here.
export async function composioAuthorizePOST(req: Request, res: Response): Promise<void> {
  try {
    if (!hasComposioKey()) {
      res.status(409).json({ error: 'Add a Composio key first.', reason: 'no-key' })
      return
    }
    const slug = String(req.params['slug'] ?? '')
    const app = BROKERED_APPS.find((a) => a.slug === slug)
    if (!app) {
      res.status(404).json({ error: `no brokered app named ${slug}` })
      return
    }

    // ASKED BEFORE ACTING. Authorizing an app that is already linked mints a
    // second consent flow and marches the operator back to the provider for
    // nothing, which is precisely the loop this rebuild exists to end.
    await refreshConnectedApps(BROKERED_TOOLKITS)
    if (connectedAppsNow().connected.has(app.toolkit.toLowerCase())) {
      res.json({ ok: true, alreadyConnected: true })
      return
    }

    const result = await authorizeApp(app.toolkit, LOCAL_USER)
    if (!result.ok) {
      res
        .status(502)
        .json({ error: `${app.name} could not be connected. ${result.error ?? ''}`.trim() })
      return
    }
    // A LINK WITH NO URL IS A FAILURE, NOT A CONNECTION. The success shape
    // without a url is indistinguishable to the shelf from "already connected",
    // so it reported the app as linked when nothing had been authorised.
    if (!result.data.redirectUrl) {
      res.status(502).json({ error: `${app.name} could not be connected.` })
      return
    }

    // The next status read must not answer from a cache taken before this.
    invalidateConnectedApps()
    res.json({ ok: true, url: result.data.redirectUrl })
  } catch (err) {
    res.status(500).json({ error: `Could not connect this app. ${safe(err)}` })
  }
}

/** Redacted and truncated. A broker's error text is written by the broker. */
function safe(err: unknown): string {
  return String(redactValue(String(err))).slice(0, 200)
}
