// @vitest-environment jsdom
//
// A thin client is a page whose control client talks to a server on another
// origin. It has no Gateway connection of its own, so nothing offers or opens
// one there. A path prefix is the same origin, not a thin client.

import { afterEach, describe, expect, it } from 'vitest'

import { resetControlClient, setApiBase } from '@clawboo/control-client'

import { isThinClient } from '../thinClient'

afterEach(() => resetControlClient())

describe('isThinClient', () => {
  it('is false for a page served by the server it talks to', () => {
    expect(isThinClient()).toBe(false)
  })

  it('is false under a path prefix, which is the same origin', () => {
    setApiBase('/clawboo')
    expect(isThinClient()).toBe(false)
  })

  it("is false for an absolute base on the page's own origin", () => {
    setApiBase(`${window.location.origin}/clawboo`)
    expect(isThinClient()).toBe(false)
  })

  it('is true for a server on another origin', () => {
    setApiBase('https://clawboo.example.com')
    expect(isThinClient()).toBe(true)
  })

  it('is true for the same host on another port', () => {
    const { protocol, hostname, port } = window.location
    const other = port === '18790' ? '18791' : '18790'
    setApiBase(`${protocol}//${hostname}:${other}`)
    expect(isThinClient()).toBe(true)
  })
})
