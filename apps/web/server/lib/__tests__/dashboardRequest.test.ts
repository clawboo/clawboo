// Did the dashboard's own page send this? The check behind every person write. A
// speed bump, so what is pinned is which callers it tells apart, not that it can't
// be fooled: anything here can be sent by hand.

import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { isDashboardRequest } from '../dashboardRequest'

const request = (headers: Record<string, string>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage

const LAN = 'http://192.168.1.10:18790'
const LAN_HOST = '192.168.1.10:18790'

describe('isDashboardRequest', () => {
  it('takes a fetch from the dashboard page on a secure address', () => {
    for (const mode of ['cors', 'same-origin'])
      expect(
        isDashboardRequest(request({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': mode })),
      ).toBe(true)
  })

  it('refuses a caller that sends nothing: a CLI, curl, an agent', () => {
    expect(isDashboardRequest(request({}))).toBe(false)
  })

  it('refuses another site, a link and a form', () => {
    expect(
      isDashboardRequest(request({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })),
    ).toBe(false)
    expect(
      isDashboardRequest(request({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' })),
    ).toBe(false)
    expect(
      isDashboardRequest(
        request({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }),
      ),
    ).toBe(false)
  })

  it("refuses Node's own fetch, which sends a mode and no site", () => {
    expect(isDashboardRequest(request({ 'sec-fetch-mode': 'cors' }))).toBe(false)
  })

  // A browser sends fetch metadata only to a secure address. On the documented
  // network bind over plain http it sends none, and the dashboard there must still
  // be able to answer an approval.
  describe('plain http to another machine', () => {
    it('takes a write whose Origin is the host it was sent to', () => {
      expect(isDashboardRequest(request({ origin: LAN, host: LAN_HOST }))).toBe(true)
    })

    it('refuses an Origin naming another host', () => {
      expect(
        isDashboardRequest(request({ origin: 'http://192.168.1.99:18790', host: LAN_HOST })),
      ).toBe(false)
    })

    it('refuses a write with an Origin and no Host to compare it with', () => {
      expect(isDashboardRequest(request({ origin: LAN }))).toBe(false)
    })

    it('refuses a broken or opaque Origin', () => {
      for (const origin of ['null', 'not a url', 'file:///x'])
        expect(isDashboardRequest(request({ origin, host: LAN_HOST }))).toBe(false)
    })

    it('refuses https, which a browser always sends metadata to', () => {
      expect(
        isDashboardRequest(
          request({ origin: 'https://dash.example.com', host: 'dash.example.com' }),
        ),
      ).toBe(false)
    })

    it('refuses an Origin on a loopback address, which a browser sends metadata to', () => {
      for (const [origin, host] of [
        ['http://localhost:18790', 'localhost:18790'],
        ['http://127.0.0.1:18790', '127.0.0.1:18790'],
        ['http://[::1]:18790', '[::1]:18790'],
        ['http://clawboo.localhost:18790', 'clawboo.localhost:18790'],
      ] as const)
        expect(isDashboardRequest(request({ origin, host })), origin).toBe(false)
    })

    it('does not rescue a request that does carry fetch metadata', () => {
      expect(
        isDashboardRequest(
          request({
            origin: LAN,
            host: LAN_HOST,
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'cors',
          }),
        ),
      ).toBe(false)
    })
  })
})
