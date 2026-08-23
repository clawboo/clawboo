// OAuth 2.1 discovery and registration for remote MCP servers.
//
// THE SHAPE OF THE FLOW, and why it is discovery-first rather than a table of
// per-provider constants. An MCP server answers an unauthenticated request with
// 401 plus a `WWW-Authenticate` header naming its protected-resource metadata
// (RFC 9728). That document names its authorization server; the server's own
// metadata names the endpoints. Every value comes from the wire, so a provider
// moving an endpoint does not require a clawboo release.
//
// DYNAMIC CLIENT REGISTRATION IS LOAD-BEARING HERE, not a nicety. clawboo has no
// registered OAuth app, and a desktop tool cannot ship a client secret. DCR is
// what lets it register itself, per install, with the exact loopback redirect it
// is about to listen on. An authorization server WITHOUT a registration endpoint
// therefore cannot be used at all by this path, and the error says so plainly
// rather than failing somewhere deeper with a redirect_uri mismatch.
//
// Pure fetch + crypto: no transport, no listener, no storage. Those belong to
// the caller, which is what keeps this testable against a stub server.

import { createHash, randomBytes } from 'node:crypto'

/** RFC 9728 protected-resource metadata, narrowed to what the flow reads. */
export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

/** RFC 8414 authorization-server metadata, narrowed likewise. */
export interface AuthServerMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
}

export interface RegisteredClient {
  client_id: string
  /** Present only for a confidential client. A desktop tool is public and should
   *  not receive one; kept because some servers send it regardless. */
  client_secret?: string
}

const FETCH_TIMEOUT_MS = 15_000

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`)
  }
  return (await res.json()) as T
}

/**
 * The protected-resource metadata URL a 401 points at.
 *
 * Parsed from `WWW-Authenticate` rather than guessed, because the path is
 * resource-specific: GitHub answers with
 * `/.well-known/oauth-protected-resource/mcp/` while Stripe uses the bare
 * well-known path. Guessing one would work for exactly one provider.
 */
export function resourceMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null
  const match = wwwAuthenticate.match(/resource_metadata="?([^",\s]+)"?/i)
  return match?.[1] ?? null
}

/** Probe the server, expecting a 401 that names its metadata. */
export async function discoverResourceMetadata(
  serverUrl: string,
): Promise<ProtectedResourceMetadata> {
  const res = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const url = resourceMetadataUrl(res.headers.get('www-authenticate'))
  if (!url) {
    throw new Error(
      `${serverUrl} did not advertise OAuth metadata (HTTP ${res.status}). ` +
        'It may not require authentication, or may not follow the MCP authorization spec.',
    )
  }
  return getJson<ProtectedResourceMetadata>(url)
}

/**
 * Authorization-server metadata for an issuer.
 *
 * RFC 8414 inserts the well-known segment BETWEEN the origin and the issuer's
 * path, which is not the same as appending it. `https://github.com/login/oauth`
 * becomes `https://github.com/.well-known/oauth-authorization-server/login/oauth`,
 * and appending instead returns a 404 that looks like "this provider does not
 * support discovery".
 */
export async function discoverAuthServer(issuer: string): Promise<AuthServerMetadata> {
  const url = new URL(issuer)
  const path = url.pathname.replace(/\/$/, '')
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    // The OpenID spelling, which some servers publish instead.
    `${url.origin}/.well-known/openid-configuration${path}`,
  ]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return await getJson<AuthServerMetadata>(candidate)
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `could not read authorization-server metadata for ${issuer}: ${String(lastError)}`,
  )
}

/**
 * Register clawboo with the authorization server, for this install only.
 *
 * `token_endpoint_auth_method: 'none'` declares a PUBLIC client. A desktop
 * application cannot keep a secret, and claiming to be confidential would be
 * asking the server to trust something that is not true.
 */
export async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  clientName = 'clawboo',
): Promise<RegisteredClient> {
  if (!metadata.registration_endpoint) {
    throw new Error(
      'this provider does not support dynamic client registration, so it needs a ' +
        'pre-registered OAuth app. clawboo cannot register itself here.',
    )
  }
  return getJson<RegisteredClient>(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
}

export interface Pkce {
  verifier: string
  challenge: string
}

/**
 * A PKCE pair, S256 only.
 *
 * `plain` is still in the spec and is worthless: it makes the challenge equal to
 * the verifier, so anyone who intercepts the redirect can complete the exchange.
 * Every authorization server checked here advertises S256, so there is nothing
 * to fall back to and no reason to want one.
 */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export interface AuthorizeUrlInput {
  metadata: AuthServerMetadata
  clientId: string
  redirectUri: string
  /** RFC 8707. Binds the token to ONE resource, so a token minted for one MCP
   *  server cannot be replayed against another that trusts the same issuer. */
  resource: string
  scopes?: string[]
  pkce: Pkce
  state: string
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('code_challenge', input.pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', input.state)
  url.searchParams.set('resource', input.resource)
  if (input.scopes?.length) url.searchParams.set('scope', input.scopes.join(' '))
  return url.toString()
}

export interface TokenSet {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

export async function exchangeCode(input: {
  metadata: AuthServerMetadata
  clientId: string
  clientSecret?: string
  redirectUri: string
  resource: string
  code: string
  pkce: Pkce
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.pkce.verifier,
    resource: input.resource,
  })
  if (input.clientSecret) body.set('client_secret', input.clientSecret)
  return getJson<TokenSet>(input.metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
}

export async function refreshToken(input: {
  metadata: AuthServerMetadata
  clientId: string
  clientSecret?: string
  resource: string
  refreshToken: string
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    resource: input.resource,
  })
  if (input.clientSecret) body.set('client_secret', input.clientSecret)
  return getJson<TokenSet>(input.metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
}
