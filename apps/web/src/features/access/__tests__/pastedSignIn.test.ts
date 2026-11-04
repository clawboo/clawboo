// Reading a sign-in link pasted on the locked screen. An app added to an
// iPhone's home screen keeps its cookies apart from Safari's, and a tapped link
// opens in Safari, so pasting the link is how that app signs in. Only the code is
// taken from what was pasted, and only from a link for this very dashboard: the
// screen posts it to its own address and never goes to the pasted one.

import { describe, expect, it } from 'vitest'

import { hasPastedMark, readPastedSignIn, signInAction, withoutPastedMark } from '../pastedSignIn'

const CODE = 'Wm9vbXpvb216b29tem9vbXpvb216b29t'
const HERE = { origin: 'https://dash.example.com', base: '' }
const MOUNTED = { origin: 'https://dash.example.com', base: '/clawboo' }

describe('readPastedSignIn', () => {
  it('takes the code from a link for this dashboard', () => {
    expect(readPastedSignIn(`https://dash.example.com/?access_code=${CODE}`, HERE)).toEqual({
      ok: true,
      code: CODE,
    })
  })

  it('takes the code from a link for this dashboard under its mount', () => {
    for (const link of [
      `https://dash.example.com/clawboo/?access_code=${CODE}`,
      `https://dash.example.com/clawboo?access_code=${CODE}`,
    ]) {
      expect(readPastedSignIn(link, MOUNTED), link).toEqual({ ok: true, code: CODE })
    }
  })

  it('takes just the code', () => {
    expect(readPastedSignIn(CODE, HERE)).toEqual({ ok: true, code: CODE })
  })

  it('ignores spaces and line breaks a chat app or a wrapped line adds', () => {
    const wrapped = `  https://dash.example.com/?access_code=${CODE.slice(0, 10)}\n${CODE.slice(10)}  `
    expect(readPastedSignIn(wrapped, HERE)).toEqual({ ok: true, code: CODE })
  })

  it('reads a link shown without its scheme as one on this page', () => {
    expect(readPastedSignIn(`dash.example.com/?access_code=${CODE}`, HERE)).toEqual({
      ok: true,
      code: CODE,
    })
  })

  it('ignores other parts of the link', () => {
    expect(
      readPastedSignIn(`https://dash.example.com/?ref=chat&access_code=${CODE}#top`, HERE),
    ).toEqual({ ok: true, code: CODE })
  })

  it('asks for something when nothing was pasted', () => {
    expect(readPastedSignIn('   ', HERE)).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses a link for another address, and names it', () => {
    for (const [link, linkOrigin] of [
      [`https://evil.example/?access_code=${CODE}`, 'https://evil.example'],
      [`http://dash.example.com/?access_code=${CODE}`, 'http://dash.example.com'],
      [`https://dash.example.com:8443/?access_code=${CODE}`, 'https://dash.example.com:8443'],
    ] as const) {
      expect(readPastedSignIn(link, HERE), link).toEqual({
        ok: false,
        reason: 'elsewhere',
        linkOrigin,
      })
    }
  })

  it('treats localhost and 127.0.0.1 as different addresses, as the browser does', () => {
    // The cookie a browser keeps for one is not sent to the other.
    const local = { origin: 'http://localhost:18790', base: '' }
    expect(readPastedSignIn(`http://127.0.0.1:18790/?access_code=${CODE}`, local)).toMatchObject({
      ok: false,
      reason: 'elsewhere',
    })
  })

  it('refuses a link for another dashboard on this address', () => {
    expect(
      readPastedSignIn(`https://dash.example.com/other/?access_code=${CODE}`, MOUNTED),
    ).toEqual({ ok: false, reason: 'other-dashboard' })
    expect(readPastedSignIn(`https://dash.example.com/?access_code=${CODE}`, MOUNTED)).toEqual({
      ok: false,
      reason: 'other-dashboard',
    })
    expect(readPastedSignIn(`https://dash.example.com/clawboo/?access_code=${CODE}`, HERE)).toEqual(
      { ok: false, reason: 'other-dashboard' },
    )
    expect(
      readPastedSignIn(`https://dash.example.com/clawboo-two/?access_code=${CODE}`, MOUNTED),
    ).toEqual({ ok: false, reason: 'other-dashboard' })
  })

  it('refuses a link that carries the access token, and keeps no copy of it', () => {
    const result = readPastedSignIn(
      'https://dash.example.com/?access_token=the-real-access-token',
      HERE,
    )
    expect(result).toEqual({ ok: false, reason: 'token' })
    expect(JSON.stringify(result)).not.toContain('the-real-access-token')
  })

  it('refuses a token link even when it also carries a code', () => {
    expect(
      readPastedSignIn(`https://dash.example.com/?access_code=${CODE}&access_token=t`, HERE),
    ).toEqual({ ok: false, reason: 'token' })
  })

  it('refuses text that is not a sign-in link', () => {
    for (const text of [
      'hello',
      'https://dash.example.com/',
      'https://dash.example.com/?access_code=',
      'https://dash.example.com/?access_code=short',
      `https://dash.example.com/?access_code=${CODE}%3Cscript%3E`,
      `https://dash.example.com/?access_code=${CODE}&access_code=${CODE}`,
      `javascript:alert(1)//?access_code=${CODE}`,
      `ftp://dash.example.com/?access_code=${CODE}`,
      `https://dash.example.com/?access_code=${'a'.repeat(5000)}`,
    ]) {
      expect(readPastedSignIn(text, HERE), text).toEqual({ ok: false, reason: 'not-a-link' })
    }
  })

  it('refuses a code on an API address, which the server never accepts', () => {
    expect(
      readPastedSignIn(`https://dash.example.com/api/settings?access_code=${CODE}`, HERE),
    ).toEqual({ ok: false, reason: 'other-dashboard' })
  })
})

describe('signInAction', () => {
  it("is this dashboard's own page, with the code and a mark that survives the redirect", () => {
    expect(signInAction(CODE, '')).toBe(`/?signin=pasted&access_code=${CODE}`)
    expect(signInAction(CODE, '/clawboo')).toBe(`/clawboo/?signin=pasted&access_code=${CODE}`)
  })
})

describe('the pasted mark', () => {
  it('is found only where the locked screen put it', () => {
    expect(hasPastedMark('?signin=pasted')).toBe(true)
    expect(hasPastedMark('?a=1&signin=pasted')).toBe(true)
    expect(hasPastedMark('')).toBe(false)
    expect(hasPastedMark('?signin=other')).toBe(false)
  })

  it('comes off the address, keeping everything else', () => {
    expect(withoutPastedMark('https://dash.example.com/clawboo/?signin=pasted')).toBe('/clawboo/')
    expect(withoutPastedMark('https://dash.example.com/?a=1&signin=pasted#x')).toBe('/?a=1#x')
    expect(withoutPastedMark('https://dash.example.com/?a=1')).toBeNull()
  })
})
