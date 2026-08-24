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
import { lookup } from 'node:dns/promises'

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

/**
 * Every URL in this flow arrives from the wire, so each one is checked before
 * it is fetched or handed to a browser.
 *
 * Loopback is exempt from the https requirement and nothing else is. A local
 * authorization server cannot be intercepted off the machine, and requiring a
 * certificate for 127.0.0.1 would make self-hosted setups untestable.
 */
function assertSafeUrl(value: string, what: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${what} is not a valid URL: ${value}`)
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(`${what} must be https, got ${url.protocol}//${url.host}`)
  }
  return url
}

/**
 * Reject a host that resolves inside the machine or the private network.
 *
 * The authorization server, and every endpoint it names, are chosen by the
 * remote MCP server. Without this, a connector could point clawboo's own process
 * at `http://169.254.169.254/`, a router's admin page, or an internal service,
 * and the status line comes back to the operator as an error naming the URL. On
 * a local-first tool that is a scanner running inside the user's network.
 *
 * WHAT THIS DOES NOT STOP: a name that resolves public here and private on the
 * fetch a moment later. Closing that needs the socket itself pinned to the
 * address we checked, which the platform fetch does not expose. This raises the
 * cost from trivial to a rebinding attack, and the same-origin rule on the
 * resource metadata is what keeps that surface to the issuer alone.
 */
async function assertPublicHost(url: URL, what: string): Promise<void> {
  let addresses: { address: string }[]
  try {
    addresses = await lookup(url.hostname, { all: true })
  } catch {
    // A name that does not resolve fails at the fetch anyway, with a better
    // message than anything invented here.
    return
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`${what} resolves to a private address (${address}), which is not allowed`)
    }
  }
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const v6 = address.toLowerCase()
    // Loopback, unique-local (fc00::/7) and link-local (fe80::/10).
    if (v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8')) {
      return true
    }
    // An IPv4-mapped address carries the v4 rules, not the v6 ones.
    const mapped = v6.startsWith('::ffff:') ? v6.slice(7) : null
    return mapped !== null ? isPrivateAddress(mapped) : false
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false
  const [a = 0, b = 0] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local, including the metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

/** Whether a URL points at this machine. Exported so the flow can decide whether
 *  a self-hosted authorization server was the operator's own choice. */
export function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopback(new URL(value))
  } catch {
    return false
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const target = assertSafeUrl(url, 'OAuth endpoint')
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`)
  }
  // A redirect that CHANGES ORIGIN is refused. fetch follows redirects for us,
  // and the token and registration requests carry the code verifier and the
  // client identity, so a 307 from a token endpoint to another host would hand
  // those to whoever the redirect names.
  const landed = new URL(res.url || url)
  if (landed.origin !== target.origin) {
    throw new Error(`${url} redirected to ${landed.origin}, which is a different host`)
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

/**
 * Probe the server, expecting a 401 that names its metadata.
 *
 * THE VALIDATION HERE IS THE WHOLE SECURITY PROPERTY, not defensive tidying.
 * Everything in this chain is chosen by the server that will RECEIVE the token,
 * so without these checks a compromised host declares somebody else's
 * authorization server and somebody else's resource identifier. The operator
 * then sees a genuine consent screen for that other provider, approves it, and
 * clawboo stores a token minted for THEM and sends it to the attacker on every
 * call. The `resource` binding cannot prevent that, because the attacker picked
 * the value that got bound.
 *
 * So: the metadata must live on the server's own origin, and the resource it
 * declares must be the server we are actually talking to.
 */
export async function discoverResourceMetadata(
  serverUrl: string,
): Promise<ProtectedResourceMetadata> {
  const server = new URL(serverUrl)
  if (server.protocol !== 'https:' && !isLoopback(server)) {
    throw new Error(`${serverUrl} is not https, so its OAuth metadata cannot be trusted`)
  }

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

  // SAME ORIGIN. A metadata URL pointing elsewhere is a server asking us to go
  // and ask a third party what it is allowed to be, and it is also the only
  // request in this flow whose destination an attacker fully controls.
  const metadataUrl = new URL(url, server)
  if (metadataUrl.origin !== server.origin) {
    throw new Error(
      `${serverUrl} pointed its OAuth metadata at ${metadataUrl.origin}, which is not its own origin`,
    )
  }

  const metadata = await getJson<ProtectedResourceMetadata>(metadataUrl.toString())

  // The declared resource must BE this server. Otherwise the token we bind is
  // bound to somebody else, and handing it to this host is handing over a
  // credential minted for a different one.
  if (!resourceMatches(metadata.resource, server)) {
    throw new Error(
      `${serverUrl} declared its OAuth resource as ${String(metadata.resource)}, which is a different server`,
    )
  }

  for (const issuer of metadata.authorization_servers ?? []) {
    const parsed = safeUrl(issuer)
    if (!parsed || (parsed.protocol !== 'https:' && !isLoopback(parsed))) {
      throw new Error(`${serverUrl} named a non-https authorization server: ${issuer}`)
    }
  }

  return metadata
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** Loopback is allowed unencrypted: it cannot leave the machine. */
function isLoopback(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'
}

/**
 * Whether a declared resource identifier really names this server.
 *
 * Origin must match exactly. The PATH is compared as a prefix rather than for
 * equality, because RFC 9728 lets a resource cover a path subtree and providers
 * differ about the trailing slash: GitHub declares
 * `https://api.githubcopilot.com/mcp/` for a server reached at the same path,
 * while Stripe declares a bare origin for `https://mcp.stripe.com`.
 */
function resourceMatches(resource: unknown, server: URL): boolean {
  if (typeof resource !== 'string') return false
  const declared = safeUrl(resource)
  if (!declared || declared.origin !== server.origin) return false
  return stripTrailingSlashes(server.pathname).startsWith(stripTrailingSlashes(declared.pathname))
}

/**
 * Drop trailing slashes in LINEAR time.
 *
 * Hand-written rather than `/\/+$/`, and the reason is not style. A greedy `+`
 * anchored at the end backtracks quadratically: the engine retries from every
 * start position, so a value of many thousand slashes costs O(n squared). Every
 * string this is applied to arrives in JSON from a remote server, which makes
 * that a denial of service somebody else gets to trigger.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
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
export async function discoverAuthServer(
  issuer: string,
  /** Set only when the connector's OWN server is on this machine, which makes a
   *  private authorization server the operator's deliberate choice rather than
   *  a remote server pointing us at the network it cannot otherwise reach. */
  opts: { allowPrivate?: boolean } = {},
): Promise<AuthServerMetadata> {
  const url = assertSafeUrl(issuer, 'authorization server')
  if (!opts.allowPrivate) await assertPublicHost(url, `authorization server ${issuer}`)
  const path = url.pathname.replace(/\/$/, '')
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    // The OpenID spelling, which some servers publish instead.
    `${url.origin}/.well-known/openid-configuration${path}`,
  ]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const metadata = await getJson<AuthServerMetadata>(candidate)
      assertIssuerMatches(metadata, issuer)
      // Each endpoint is checked in its own right: the metadata document may
      // name a different host from the issuer, and those are the URLs that
      // actually receive the code verifier and the client identity.
      const endpoints = [
        ['authorization_endpoint', metadata.authorization_endpoint],
        ['token_endpoint', metadata.token_endpoint],
        ...(metadata.registration_endpoint
          ? [['registration_endpoint', metadata.registration_endpoint] as const]
          : []),
      ] as const
      for (const [what, value] of endpoints) {
        const parsed = assertSafeUrl(value, what)
        if (!opts.allowPrivate) await assertPublicHost(parsed, what)
      }
      return metadata
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `could not read authorization-server metadata for ${issuer}: ${String(lastError)}`,
  )
}

/**
 * RFC 8414 3.3: the `issuer` in the document must be the one we asked about.
 *
 * This is the check that stops a document served from one authorization server
 * claiming to be another. Without it, discovery would accept metadata that names
 * somebody else's endpoints, which is the same substitution the resource check
 * closes one layer up.
 */
function assertIssuerMatches(metadata: AuthServerMetadata, issuer: string): void {
  if (metadata.issuer === undefined) return
  if (stripTrailingSlashes(metadata.issuer) !== stripTrailingSlashes(issuer)) {
    throw new Error(`metadata for ${issuer} claims to be issued by ${metadata.issuer}`)
  }
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
  // Re-checked here even though discovery checked it, because this string is
  // handed to a browsing context's `location`. A `javascript:` authorization
  // endpoint would otherwise be script execution on the page that opened it.
  const url = assertSafeUrl(input.metadata.authorization_endpoint, 'authorization_endpoint')
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
