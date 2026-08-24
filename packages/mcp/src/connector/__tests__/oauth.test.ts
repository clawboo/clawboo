import { afterEach, describe, expect, it } from 'vitest'

import {
  buildAuthorizeUrl,
  createPkce,
  discoverAuthServer,
  discoverResourceMetadata,
  isLoopbackUrl,
  resourceMetadataUrl,
} from '../oauth'

describe('resourceMetadataUrl', () => {
  it('parses the quoted form GitHub sends', () => {
    expect(
      resourceMetadataUrl(
        'Bearer error="invalid_request", resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"',
      ),
    ).toBe('https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/')
  })

  it('parses the UNQUOTED form Stripe sends', () => {
    // Both are live today. A parser that handled only one would work for exactly
    // one provider, which is the failure a per-provider table makes invisible.
    expect(
      resourceMetadataUrl(
        'Bearer resource_metadata=https://mcp.stripe.com/.well-known/oauth-protected-resource',
      ),
    ).toBe('https://mcp.stripe.com/.well-known/oauth-protected-resource')
  })

  it('returns null when the header says nothing about metadata', () => {
    expect(resourceMetadataUrl('Bearer realm="OAuth"')).toBeNull()
    expect(resourceMetadataUrl(null)).toBeNull()
  })
})

describe('createPkce', () => {
  it('produces an S256 challenge that is not the verifier', () => {
    // `plain` makes the challenge equal the verifier, so anyone who intercepts
    // the redirect can complete the exchange. There is no fallback to it here.
    const { verifier, challenge } = createPkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(challenge).not.toBe(verifier)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is different every time', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier)
  })
})

describe('buildAuthorizeUrl', () => {
  const metadata = {
    authorization_endpoint: 'https://example.com/authorize',
    token_endpoint: 'https://example.com/token',
  }

  it('carries PKCE, state and the RFC 8707 resource', () => {
    const pkce = createPkce()
    const url = new URL(
      buildAuthorizeUrl({
        metadata,
        clientId: 'abc',
        redirectUri: 'http://127.0.0.1:5511/callback',
        resource: 'https://mcp.example.com/mcp',
        pkce,
        state: 'st',
        scopes: ['read', 'write'],
      }),
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    // The resource binding is what stops a token minted for one MCP server being
    // replayed against another that trusts the same issuer.
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('scope')).toBe('read write')
    // The verifier must NEVER travel in the authorize request.
    expect(url.toString()).not.toContain(pkce.verifier)
  })

  it('preserves a query already on the authorization endpoint', () => {
    const url = new URL(
      buildAuthorizeUrl({
        metadata: { ...metadata, authorization_endpoint: 'https://example.com/authorize?tenant=x' },
        clientId: 'abc',
        redirectUri: 'http://127.0.0.1:1/callback',
        resource: 'https://r',
        pkce: createPkce(),
        state: 's',
      }),
    )
    expect(url.searchParams.get('tenant')).toBe('x')
    expect(url.searchParams.get('client_id')).toBe('abc')
  })
})

describe('buildAuthorizeUrl scheme check', () => {
  it('REFUSES a javascript: authorization endpoint', () => {
    // This string is handed to a browsing context's `location`. A hostile
    // authorization-server metadata document naming a `javascript:` endpoint
    // would otherwise be script execution on the page that opened the tab.
    expect(() =>
      buildAuthorizeUrl({
        metadata: {
          authorization_endpoint: 'javascript:alert(1)',
          token_endpoint: 'https://example.com/token',
        },
        clientId: 'abc',
        redirectUri: 'http://127.0.0.1:1/callback',
        resource: 'https://r',
        pkce: createPkce(),
        state: 's',
      }),
    ).toThrow(/must be https/)
  })

  it('refuses a plain-http endpoint that is not loopback', () => {
    expect(() =>
      buildAuthorizeUrl({
        metadata: {
          authorization_endpoint: 'http://evil.example/authorize',
          token_endpoint: 'https://example.com/token',
        },
        clientId: 'abc',
        redirectUri: 'http://127.0.0.1:1/callback',
        resource: 'https://r',
        pkce: createPkce(),
        state: 's',
      }),
    ).toThrow(/must be https/)
  })
})

describe('discoverResourceMetadata', () => {
  // THE SUBSTITUTION ATTACK these checks exist for: every value in the discovery
  // chain is chosen by the server that will receive the token. A compromised
  // host that can name somebody else's authorization server, and somebody else's
  // resource identifier, sends the operator to a GENUINE consent screen for that
  // other provider and receives a token minted for them. The RFC 8707 `resource`
  // binding cannot prevent it, because the attacker picked the bound value.
  const original = globalThis.fetch

  function stub(handler: (url: string) => Response): void {
    globalThis.fetch = ((input: string | URL) =>
      Promise.resolve(handler(String(input)))) as typeof fetch
  }
  function json(body: unknown, url: string): Response {
    const res = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    // `res.url` is what the same-origin redirect check reads, and it is
    // read-only on a constructed Response.
    Object.defineProperty(res, 'url', { value: url })
    return res
  }
  function challenge(metadataUrl: string): Response {
    return new Response('{}', {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` },
    })
  }

  afterEach(() => {
    globalThis.fetch = original
  })

  it('accepts metadata served by the server itself', async () => {
    stub((url) =>
      url === 'https://mcp.example.com/mcp'
        ? challenge('https://mcp.example.com/.well-known/oauth-protected-resource')
        : json(
            {
              resource: 'https://mcp.example.com/mcp',
              authorization_servers: ['https://auth.example.com'],
            },
            url,
          ),
    )
    const metadata = await discoverResourceMetadata('https://mcp.example.com/mcp')
    expect(metadata.authorization_servers).toEqual(['https://auth.example.com'])
  })

  it('accepts a resource that covers the path as a PREFIX', async () => {
    // Providers differ about the trailing slash and about how much of the path
    // the resource identifier names. Stripe declares a bare origin for a server
    // reached at that origin.
    stub((url) =>
      url === 'https://mcp.stripe.com'
        ? challenge('https://mcp.stripe.com/.well-known/oauth-protected-resource')
        : json(
            { resource: 'https://mcp.stripe.com/', authorization_servers: ['https://auth.stripe'] },
            url,
          ),
    )
    await expect(discoverResourceMetadata('https://mcp.stripe.com')).resolves.toBeTruthy()
  })

  it('REFUSES metadata hosted on another origin', async () => {
    stub((url) =>
      url === 'https://evil.example/mcp'
        ? challenge('https://mcp.linear.app/.well-known/oauth-protected-resource')
        : json(
            {
              resource: 'https://mcp.linear.app/mcp',
              authorization_servers: ['https://linear.app'],
            },
            url,
          ),
    )
    await expect(discoverResourceMetadata('https://evil.example/mcp')).rejects.toThrow(
      /not its own origin/,
    )
  })

  it('REFUSES a resource identifier naming a different server', async () => {
    // Same-origin metadata, but it claims to be Linear. The token would be
    // minted for Linear and sent to this host.
    stub((url) =>
      url === 'https://evil.example/mcp'
        ? challenge('https://evil.example/.well-known/oauth-protected-resource')
        : json(
            {
              resource: 'https://mcp.linear.app/mcp',
              authorization_servers: ['https://linear.app'],
            },
            url,
          ),
    )
    await expect(discoverResourceMetadata('https://evil.example/mcp')).rejects.toThrow(
      /different server/,
    )
  })

  it('REFUSES a non-https authorization server', async () => {
    stub((url) =>
      url === 'https://mcp.example.com/mcp'
        ? challenge('https://mcp.example.com/.well-known/oauth-protected-resource')
        : json(
            {
              resource: 'https://mcp.example.com/mcp',
              authorization_servers: ['http://auth.example.com'],
            },
            url,
          ),
    )
    await expect(discoverResourceMetadata('https://mcp.example.com/mcp')).rejects.toThrow(
      /non-https authorization server/,
    )
  })

  it('normalises a pathological run of slashes in LINEAR time', async () => {
    // The regression: trailing slashes were stripped with `/\/+$/`, which
    // backtracks quadratically, and the string comes from a remote server's
    // JSON. 200k slashes took long enough to be a denial of service somebody
    // else could trigger; the budget here is far above the linear cost and far
    // below the quadratic one.
    const pathological = `https://mcp.example.com/${'/'.repeat(200_000)}x`
    stub((url) =>
      url === 'https://mcp.example.com/mcp'
        ? challenge('https://mcp.example.com/.well-known/oauth-protected-resource')
        : json(
            { resource: pathological, authorization_servers: ['https://auth.example.com'] },
            url,
          ),
    )
    const started = Date.now()
    await expect(discoverResourceMetadata('https://mcp.example.com/mcp')).rejects.toThrow(
      /different server/,
    )
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('refuses to probe a non-https server at all', async () => {
    await expect(discoverResourceMetadata('http://mcp.example.com/mcp')).rejects.toThrow(
      /not https/,
    )
  })
})

describe('discoverAuthServer private-network guard', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('REFUSES an authorization server that resolves inside the network', async () => {
    // The issuer is chosen by the remote MCP server. Without this it could aim
    // clawboo's own process at a router, an internal service, or the cloud
    // metadata endpoint, and the status comes back to the operator as an error
    // naming the URL.
    globalThis.fetch = (() => {
      throw new Error('must not be fetched')
    }) as typeof fetch
    // Literal addresses, so this needs no DNS and cannot flake on a runner
    // without a resolver. `dns.lookup` returns an IP literal unchanged.
    await expect(discoverAuthServer('https://192.168.1.1')).rejects.toThrow(/private address/)
    // The cloud metadata endpoint, which is the one everybody actually goes for.
    await expect(discoverAuthServer('https://169.254.169.254')).rejects.toThrow(/private address/)
    await expect(discoverAuthServer('https://10.0.0.5')).rejects.toThrow(/private address/)
  })

  it('allows one when the connector itself is on this machine', async () => {
    // A self-hosted authorization server is the operator's own choice, not a
    // remote server reaching somewhere it otherwise could not.
    expect(isLoopbackUrl('http://127.0.0.1:9000/mcp')).toBe(true)
    expect(isLoopbackUrl('https://mcp.linear.app/mcp')).toBe(false)
    const doc = JSON.stringify({
      issuer: 'https://192.168.1.1',
      authorization_endpoint: 'https://192.168.1.1/authorize',
      token_endpoint: 'https://192.168.1.1/token',
    })
    globalThis.fetch = (async (input: string | URL) => {
      const res = new Response(doc, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
      Object.defineProperty(res, 'url', { value: String(input) })
      return res
    }) as unknown as typeof fetch
    await expect(
      discoverAuthServer('https://192.168.1.1', { allowPrivate: true }),
    ).resolves.toBeTruthy()
  })
})
