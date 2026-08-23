import { describe, expect, it } from 'vitest'

import { buildAuthorizeUrl, createPkce, resourceMetadataUrl } from '../oauth'

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
