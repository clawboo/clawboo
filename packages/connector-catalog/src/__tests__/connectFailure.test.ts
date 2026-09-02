// Every input here is a real shape one of the four layers actually emits.

import { describe, expect, it } from 'vitest'

import { explainConnectFailure } from '../connectFailure'

describe('explainConnectFailure', () => {
  it('names the missing runtime, not the missing package', () => {
    const out = explainConnectFailure('Error: spawn npx ENOENT', 'Playwright')
    expect(out.message).toContain('Node.js')
    expect(out.message).toContain('Playwright')
    expect(out.message).not.toContain('ENOENT')
  })

  it('tells a uv user to install uv, not Node', () => {
    expect(explainConnectFailure('Error: spawn uvx ENOENT', 'Some Server').message).toContain('uv')
  })

  it('reads an unpublished package as removed rather than as a clawboo fault', () => {
    const out = explainConnectFailure('npm ERR! code E404\nnpm ERR! 404 Not Found', 'ClickUp')
    expect(out.message).toContain('no longer published')
  })

  it('blames the key, not the product, when the key is refused', () => {
    // The case the old copy got worst: a bare 502 read as "clawboo is broken"
    // to somebody who had just pasted a perfectly good-looking token.
    const out = explainConnectFailure('Request failed: 401 Unauthorized', 'Notion')
    expect(out.message).toContain('did not accept that key')
  })

  it('distinguishes a missing permission from a bad key', () => {
    const out = explainConnectFailure('403 Forbidden: missing scope repo', 'GitHub')
    expect(out.message).toContain('permission')
    expect(out.message).not.toContain('did not accept that key')
  })

  it('names a timeout and a network failure separately', () => {
    expect(explainConnectFailure('ETIMEDOUT', 'Sentry').message).toContain(
      'did not respond in time',
    )
    expect(explainConnectFailure('getaddrinfo ENOTFOUND api.x.com', 'Stripe').message).toContain(
      'could not reach',
    )
  })

  it('reads a missing path as a path problem', () => {
    const out = explainConnectFailure(
      "ENOENT: no such file or directory, open '/tmp/a.db'",
      'SQLite',
    )
    expect(out.message).toContain('path still exists')
  })

  it('always keeps the original text as detail, never discards it', () => {
    const raw = 'MCP error -32603: internal error'
    const out = explainConnectFailure(raw, 'Linear')
    expect(out.detail).toBe(raw)
    expect(out.message).toBe('Linear did not start.')
  })

  it('is safe on empty input', () => {
    const out = explainConnectFailure('', 'Figma')
    expect(out.message).toBe('Figma did not start.')
    expect(out.detail).toBe('')
  })
})
