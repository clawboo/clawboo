// A loopback-bound server with no access token starts without complaint, even when
// a reverse proxy in front of it opens every /api/* route to the internet. The first
// forwarded request is where the server can tell, and it must say so, once.

import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { createProxyExposureWarning } from '../proxyExposureWarning'

const req = (headers: Record<string, string> = {}): IncomingMessage =>
  ({ url: '/api/settings', headers }) as unknown as IncomingMessage

function harness(gateEnabled: boolean) {
  const warnings: string[] = []
  const observe = createProxyExposureWarning({ gateEnabled, warn: (m) => warnings.push(m) })
  return { observe, warnings }
}

describe('createProxyExposureWarning', () => {
  const forwarded: Record<string, string>[] = [
    { 'x-forwarded-for': '203.0.113.7' },
    { 'x-forwarded-proto': 'https' },
    { 'x-forwarded-host': 'dash.example.com' },
    { forwarded: 'for=203.0.113.7' },
    { 'x-real-ip': '203.0.113.7' },
  ]
  for (const headers of forwarded) {
    it(`warns on a forwarded request with the gate off (${Object.keys(headers)[0]})`, () => {
      const { observe, warnings } = harness(false)
      observe(req(headers))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('STUDIO_ACCESS_TOKEN')
    })
  }

  it('warns once per process, not once per request', () => {
    const { observe, warnings } = harness(false)
    for (let i = 0; i < 5; i++) observe(req({ 'x-forwarded-for': '203.0.113.7' }))
    expect(warnings).toHaveLength(1)
  })

  it('stays quiet for direct requests (the default local install)', () => {
    const { observe, warnings } = harness(false)
    observe(req())
    observe(req({ host: '127.0.0.1:18790' }))
    expect(warnings).toEqual([])
  })

  it('stays quiet when the gate is on: the token is the protection', () => {
    const { observe, warnings } = harness(true)
    observe(req({ 'x-forwarded-for': '203.0.113.7' }))
    expect(warnings).toEqual([])
  })
})
