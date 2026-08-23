// The interactive OAuth flow for a remote connector.
//
// Runs entirely server-side and hands the browser one URL to open. The callback
// lands on an ephemeral loopback listener rather than an Express route, because
// the redirect back is a cross-site top-level navigation and the always-on
// same-origin guard refuses precisely that.
//
// WHY THIS IS A SEPARATE, EXPLICIT STEP rather than something a connect attempt
// triggers: signing in opens a browser and asks a human for consent. A flow that
// started that on its own, from a background reconnect or a boot, would be a tool
// popping up an authorization page nobody asked for.

import {
  buildAuthorizeUrl,
  createPkce,
  discoverAuthServer,
  discoverResourceMetadata,
  exchangeCode,
  refreshToken as refreshOAuthToken,
  registerClient,
  type AuthServerMetadata,
} from '@clawboo/mcp'
import { randomBytes } from 'node:crypto'

import { startOAuthListener } from './oauthListener'
import {
  getStoredClient,
  getStoredTokens,
  saveStoredClient,
  saveStoredTokens,
  type StoredClient,
  type StoredTokens,
} from './oauthStore'

/** An authorization the user has started but not finished. */
interface PendingAuth {
  slug: string
  metadata: AuthServerMetadata
  clientId: string
  clientSecret?: string
  redirectUri: string
  resource: string
  verifier: string
  state: string
  /** Resolves when the callback arrives, or rejects on error or timeout. */
  completion: Promise<void>
  /** Abandon this attempt and release its port. */
  cancel: () => void
}

const pending = new Map<string, PendingAuth>()

export interface AuthorizeStart {
  /** The URL the operator must open. Returned rather than opened for them: the
   *  server may not be on the machine with the browser. */
  authorizeUrl: string
}

/**
 * Begin authorization: discover, register, and return a URL to open.
 *
 * The listener is already bound before this returns, so the redirect cannot
 * arrive before anything is listening for it.
 */
export async function beginAuthorization(
  slug: string,
  serverUrl: string,
  /**
   * The connector's PINNED scopes, from the catalog. Optional because most
   * providers here pin none and apply their own default at the consent screen.
   */
  scopes?: readonly string[],
): Promise<AuthorizeStart> {
  const resource = await discoverResourceMetadata(serverUrl)
  const issuer = resource.authorization_servers?.[0]
  if (!issuer) {
    throw new Error(`${serverUrl} did not name an authorization server`)
  }
  const metadata = await discoverAuthServer(issuer)

  // An earlier sign-in the operator abandoned still holds a bound port and a
  // promise nobody will resolve. Cancel it before starting another, or the tab
  // they open now would resolve the OLD attempt while this one waits forever.
  const previous = pending.get(slug)
  if (previous) {
    previous.cancel()
    pending.delete(slug)
  }

  const pkce = createPkce()
  const state = randomBytes(16).toString('base64url')

  // Ask for the SAME PORT the last registration was pinned to. Dynamic
  // registration fixes a redirect_uri, so a fresh ephemeral port every time
  // means registering again every time, which leaves a trail of dead clients on
  // the provider's side and runs into per-client rate limits. When the port is
  // taken the listener falls back to an ephemeral one and the mismatch below
  // re-registers, so this is an optimisation that cannot break the flow.
  const stored = getStoredClient(slug)
  const preferredPort = portOf(stored?.redirect_uri)

  const listener = await startOAuthListener({
    expectedState: state,
    ...(preferredPort ? { preferredPort } : {}),
  })

  let client: StoredClient
  try {
    // Reuse an existing registration only when its redirect still MATCHES. A
    // registration PINS its redirect_uri, so reusing one registered against a
    // different port is rejected by the provider for redirect_uri mismatch.
    if (stored && stored.redirect_uri === listener.redirectUri) {
      client = stored
    } else {
      const registered = await registerClient(metadata, listener.redirectUri, `clawboo (${slug})`)
      client = {
        client_id: registered.client_id,
        ...(registered.client_secret ? { client_secret: registered.client_secret } : {}),
        redirect_uri: listener.redirectUri,
      }
      saveStoredClient(slug, client)
    }
  } catch (err) {
    // The listener is already BOUND at this point. Registration failing is the
    // ordinary case for a provider without dynamic registration, and every one
    // of those clicks used to leave a socket bound on loopback forever.
    listener.close()
    throw err
  }

  const completion = listener
    .waitForCallback()
    .then(async (cb) => {
      // Belt and braces: the listener already refuses a mismatched state, and
      // this is the check that makes the guarantee local to the exchange. An
      // attacker-supplied authorization code redeemed here would bind the
      // operator's connector to the attacker's account.
      if (cb.state !== state) throw new Error('state mismatch, authorization refused')
      const tokens = await exchangeCode({
        metadata,
        clientId: client.client_id,
        ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
        redirectUri: listener.redirectUri,
        resource: resource.resource,
        code: cb.code,
        pkce,
      })
      saveStoredTokens(slug, toStored(tokens))
      listener.settle({ ok: true, detail: 'clawboo has the credentials it needs.' })
    })
    .catch((err: unknown) => {
      // The operator is looking at the callback tab, so the failure is reported
      // THERE rather than only in a log they are not reading.
      listener.settle({ ok: false, detail: messageOf(err) })
      throw err
    })
    .finally(() => {
      listener.close()
      // Only if this attempt is still the current one. A cancelled sign-in stays
      // pending until its own timeout fires, and an unconditional delete would
      // then remove a newer attempt that had legitimately taken the slug.
      if (pending.get(slug) === entry) pending.delete(slug)
    })

  // Nobody may await this yet, and an unhandled rejection would be reported as a
  // crash rather than as a sign-in the user abandoned.
  completion.catch(() => {})

  const entry: PendingAuth = {
    slug,
    cancel: () => listener.close(),
    metadata,
    clientId: client.client_id,
    ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
    redirectUri: listener.redirectUri,
    resource: resource.resource,
    verifier: pkce.verifier,
    state,
    completion,
  }
  pending.set(slug, entry)

  return {
    authorizeUrl: buildAuthorizeUrl({
      metadata,
      clientId: client.client_id,
      redirectUri: listener.redirectUri,
      resource: resource.resource,
      // The PINNED scopes only. Sending the provider's advertised
      // `scopes_supported` would ask for its entire catalog, which is both more
      // than the connector needs and more than the consent copy says is being
      // requested. With none pinned we send no `scope` at all and let the
      // provider apply its default, which is what its own consent screen shows.
      ...(scopes?.length ? { scopes: [...scopes] } : {}),
      pkce,
      state,
    }),
  }
}

function portOf(redirectUri: string | undefined): number | null {
  if (!redirectUri) return null
  try {
    const port = Number(new URL(redirectUri).port)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Wait for an in-flight authorization to finish. */
export async function awaitAuthorization(slug: string): Promise<void> {
  const entry = pending.get(slug)
  if (!entry) throw new Error('no sign-in is in progress for this connector')
  await entry.completion
}

function toStored(tokens: {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}): StoredTokens {
  return {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    // Absent `expires_in` means the provider did not say. Recording no expiry is
    // the honest reading; a 401 is then the signal, and the refresh below is
    // what answers it.
    ...(tokens.expires_in ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  }
}

/** Treat a token as stale slightly early, so a call does not race its expiry. */
const REFRESH_SKEW_MS = 60_000

/**
 * A usable access token, refreshing first when the stored one has expired.
 *
 * Returns null when the connector has never been authorized or the refresh
 * failed, which the caller renders as "sign in again" rather than as an error:
 * a revoked or expired grant on the provider's side is an ordinary thing.
 */
export async function getAccessToken(slug: string, serverUrl: string): Promise<string | null> {
  const stored = getStoredTokens(slug)
  if (!stored) return null

  const fresh = stored.expires_at === undefined || stored.expires_at - REFRESH_SKEW_MS > Date.now()
  if (fresh) return stored.access_token
  if (!stored.refresh_token) return null

  const client = getStoredClient(slug)
  if (!client) return null

  try {
    const resource = await discoverResourceMetadata(serverUrl)
    const issuer = resource.authorization_servers?.[0]
    if (!issuer) return null
    const metadata = await discoverAuthServer(issuer)
    const next = await refreshOAuthToken({
      metadata,
      clientId: client.client_id,
      ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
      resource: resource.resource,
      refreshToken: stored.refresh_token,
    })
    const merged = toStored(next)
    // Providers commonly omit the refresh token on a refresh response, meaning
    // "keep the one you have". Dropping it would silently turn a long-lived
    // authorization into a single-use one.
    if (!merged.refresh_token && stored.refresh_token) merged.refresh_token = stored.refresh_token
    saveStoredTokens(slug, merged)
    return merged.access_token
  } catch {
    return null
  }
}
