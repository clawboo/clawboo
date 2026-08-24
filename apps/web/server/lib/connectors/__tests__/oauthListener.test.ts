// The callback listener, against real HTTP on a real ephemeral port. The whole
// reason it exists is that this CANNOT be an Express route: the redirect back is
// a cross-site top-level navigation, and the always-on origin guard refuses
// exactly that.

import { describe, expect, it } from 'vitest'

import { startOAuthListener } from '../oauthListener'

describe('oauth callback listener', () => {
  it('binds an ephemeral port on the IPv4 literal', async () => {
    const listener = await startOAuthListener()
    try {
      // 127.0.0.1, not `localhost`: the name can resolve to ::1 first, and a
      // provider that registered the IPv4 literal would then redirect to a port
      // nothing is listening on.
      expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    } finally {
      listener.close()
    }
  })

  it('resolves with the code and state the provider sent', async () => {
    const listener = await startOAuthListener()
    try {
      const pending = listener.waitForCallback()
      const response = fetch(`${listener.redirectUri}?code=abc123&state=st42`)
      // The callback resolves first; the RESPONSE is still open, because the
      // exchange has not happened yet and there is nothing truthful to render.
      expect(await pending).toEqual({ code: 'abc123', state: 'st42' })
      listener.settle({ ok: true, detail: 'clawboo has the credentials it needs.' })
      const res = await response
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Connected')
    } finally {
      listener.close()
    }
  })

  it('does not claim success until the exchange has actually happened', async () => {
    // The tab used to render "Connected" the moment the code arrived, so a state
    // mismatch or a dead token endpoint still showed a success page.
    const listener = await startOAuthListener()
    try {
      const pending = listener.waitForCallback()
      const response = fetch(`${listener.redirectUri}?code=abc123&state=st42`)
      await pending
      listener.settle({ ok: false, detail: 'the token endpoint refused' })
      const res = await response
      expect(res.status).toBe(400)
      const body = await res.text()
      expect(body).toContain('the token endpoint refused')
      expect(body).not.toContain('Connected')
    } finally {
      listener.close()
    }
  })

  it('IGNORES a callback whose state does not match', async () => {
    // The port is reachable by anything else on the machine, including a page
    // the operator happens to have open. One unauthenticated request used to
    // abort whatever sign-in was in flight.
    const listener = await startOAuthListener({ expectedState: 'the-real-one' })
    try {
      const pending = listener.waitForCallback()
      let settledEarly = false
      void pending.then(
        () => (settledEarly = true),
        () => (settledEarly = true),
      )
      expect((await fetch(`${listener.redirectUri}?code=x&state=guessed`)).status).toBe(404)
      expect(
        (await fetch(`${listener.redirectUri}?error=access_denied&state=guessed`)).status,
      ).toBe(404)
      await new Promise((r) => setTimeout(r, 20))
      expect(settledEarly).toBe(false)

      // ...and the real one still works.
      const response = fetch(`${listener.redirectUri}?code=abc&state=the-real-one`)
      expect(await pending).toEqual({ code: 'abc', state: 'the-real-one' })
      listener.settle({ ok: true, detail: 'done' })
      await response
    } finally {
      listener.close()
    }
  })

  it('reuses a preferred port, which is what lets a registration be reused', async () => {
    // Dynamic registration PINS a redirect_uri. A fresh ephemeral port on every
    // attempt means registering again on every attempt.
    const first = await startOAuthListener()
    const port = first.port
    first.close()
    const second = await startOAuthListener({ preferredPort: port })
    try {
      expect(second.port).toBe(port)
    } finally {
      second.close()
    }
  })

  it('falls back to an ephemeral port when the preferred one is taken', async () => {
    const holder = await startOAuthListener()
    const other = await startOAuthListener({ preferredPort: holder.port })
    try {
      expect(other.port).not.toBe(holder.port)
      expect(other.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    } finally {
      holder.close()
      other.close()
    }
  })

  it('rejects when the provider reports an error, and shows its reason', async () => {
    const listener = await startOAuthListener()
    try {
      // The assertion is attached BEFORE the request that triggers the
      // rejection: otherwise the promise is briefly unhandled and the runner
      // reports it as an unhandled rejection.
      const rejected = expect(listener.waitForCallback()).rejects.toThrow(/access_denied/)
      const res = await fetch(
        `${listener.redirectUri}?error=access_denied&error_description=User+said+no`,
      )
      // The provider's own words reach the tab: paraphrasing them would lose the
      // only explanation of why it failed.
      expect(await res.text()).toContain('User said no')
      await rejected
    } finally {
      listener.close()
    }
  })

  it('ESCAPES the provider-supplied description', async () => {
    // That string is attacker-influenceable and lands in a page we render.
    const listener = await startOAuthListener()
    try {
      // Swallowed: this case only exercises the rendered page.
      listener.waitForCallback().catch(() => {})
      const res = await fetch(
        `${listener.redirectUri}?error=bad&error_description=${encodeURIComponent('<script>alert(1)</script>')}`,
      )
      const body = await res.text()
      expect(body).not.toContain('<script>alert(1)</script>')
      expect(body).toContain('&lt;script&gt;')
    } finally {
      listener.close()
    }
  })

  it('404s any path that is not the callback', async () => {
    const listener = await startOAuthListener()
    try {
      const base = listener.redirectUri.replace('/callback', '')
      expect((await fetch(`${base}/anything-else`)).status).toBe(404)
    } finally {
      listener.close()
    }
  })

  it('rejects a callback with no code', async () => {
    const listener = await startOAuthListener()
    try {
      const rejected = expect(listener.waitForCallback()).rejects.toThrow(/missing code/)
      await fetch(`${listener.redirectUri}?state=only`)
      await rejected
    } finally {
      listener.close()
    }
  })

  it('gives each attempt its own port', async () => {
    const a = await startOAuthListener()
    const b = await startOAuthListener()
    try {
      expect(a.redirectUri).not.toBe(b.redirectUri)
    } finally {
      a.close()
      b.close()
    }
  })
})
