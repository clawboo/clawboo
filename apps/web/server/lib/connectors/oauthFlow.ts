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
export async function beginAuthorization(slug: string, serverUrl: string): Promise<AuthorizeStart> {
  const resource = await discoverResourceMetadata(serverUrl)
  const issuer = resource.authorization_servers?.[0]
  if (!issuer) {
    throw new Error(`${serverUrl} did not name an authorization server`)
  }
  const metadata = await discoverAuthServer(issuer)

  const listener = await startOAuthListener()

  // Reuse an existing registration when we have one. Registering again on every
  // sign-in would leave a trail of dead clients on the provider's side, and some
  // rate-limit it.
  let client = getStoredClient(slug)
  if (!client) {
    const registered = await registerClient(metadata, listener.redirectUri, `clawboo (${slug})`)
    client = {
      client_id: registered.client_id,
      ...(registered.client_secret ? { client_secret: registered.client_secret } : {}),
    }
    saveStoredClient(slug, client)
  }

  const pkce = createPkce()
  const state = randomBytes(16).toString('base64url')

  const completion = listener
    .waitForCallback()
    .then(async (cb) => {
      // The state check is the CSRF defence: without it, an attacker who can
      // reach the loopback port could feed us their own authorization code and
      // bind the operator's connector to the attacker's account.
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
    })
    .finally(() => {
      listener.close()
      pending.delete(slug)
    })

  // Nobody may await this yet, and an unhandled rejection would be reported as a
  // crash rather than as a sign-in the user abandoned.
  completion.catch(() => {})

  pending.set(slug, {
    slug,
    metadata,
    clientId: client.client_id,
    ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
    redirectUri: listener.redirectUri,
    resource: resource.resource,
    verifier: pkce.verifier,
    state,
    completion,
  })

  return {
    authorizeUrl: buildAuthorizeUrl({
      metadata,
      clientId: client.client_id,
      redirectUri: listener.redirectUri,
      resource: resource.resource,
      ...(resource.scopes_supported?.length ? { scopes: resource.scopes_supported } : {}),
      pkce,
      state,
    }),
  }
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
