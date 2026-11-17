import type { Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  actingPerson,
  actorField,
  actsAsPerson,
  attachIdentity,
  controlClaimFor,
  getUserId,
  personOf,
  refuseUnlessPerson,
} from '../auth'
import { resetPersonCheckForTests, setPersonCheckMode, type PersonCheckMode } from '../personCheck'

describe('attachIdentity (the no-op identity middleware seam)', () => {
  it('populates req.tenantId / req.userId (both null today) and calls next() once with no error', () => {
    const req = {} as Request
    const res = {} as Response
    const next = vi.fn()

    attachIdentity(req, res, next)

    expect(req.tenantId).toBeNull()
    expect(req.userId).toBeNull()
    expect(next).toHaveBeenCalledTimes(1)
    // next() with no argument = continue the chain (never next(err) — this never blocks).
    expect(next).toHaveBeenCalledWith()
  })

  it('is a transparent pass-through — never touches the response', () => {
    const req = {} as Request
    const res = {
      status: vi.fn(),
      json: vi.fn(),
      send: vi.fn(),
      end: vi.fn(),
    } as unknown as Response
    const next = vi.fn()

    attachIdentity(req, res, next)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(res.send).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  it('getUserId returns null — the single implicit user', () => {
    expect(getUserId({} as Request)).toBeNull()
  })

  it('getUserId and personOf return the person a verified proxy token named', () => {
    const person = { id: 'u-1', name: 'Ada', role: 'admin' }
    const req = { person } as Request
    expect(getUserId(req)).toBe('u-1')
    expect(personOf(req)).toEqual(person)
    expect(personOf({} as Request)).toBeNull()
  })
})

// Who may act as the person, in each mode of the person check. The page's own
// marks (fetch metadata, or Origin matching Host over plain http) count only in
// `page` mode; a verified person counts in both; a service token and a reader
// key's program never do.
describe('actsAsPerson across the person check modes', () => {
  afterEach(() => resetPersonCheckForTests())

  const ADA = { id: 'user-42', name: 'Ada', role: 'admin' }
  const FETCH_MARKS = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
  // Plain http to a network address: no fetch metadata, Origin names the host.
  const ORIGIN_MARK = { origin: 'http://192.168.1.20:3000', host: '192.168.1.20:3000' }

  const req = (over: {
    headers?: Record<string, string>
    person?: typeof ADA | null
    personVia?: 'proxy' | 'app'
    service?: typeof ADA | null
    reader?: string | null
    controlClaim?: string | null
  }): Request =>
    ({ headers: {}, person: null, method: 'POST', path: '/api/x', ...over }) as unknown as Request

  const cases: Array<{
    name: string
    r: Request
    page: boolean
    verified: boolean
  }> = [
    { name: 'nothing', r: req({}), page: false, verified: false },
    {
      name: 'the page, by fetch metadata',
      r: req({ headers: FETCH_MARKS }),
      page: true,
      verified: false,
    },
    {
      name: 'the page, by Origin over plain http',
      r: req({ headers: ORIGIN_MARK }),
      page: true,
      verified: false,
    },
    {
      name: 'a proxy person',
      r: req({ person: ADA, personVia: 'proxy' }),
      page: true,
      verified: true,
    },
    {
      name: 'a proxy person on the page',
      r: req({ person: ADA, personVia: 'proxy', headers: FETCH_MARKS }),
      page: true,
      verified: true,
    },
    {
      name: "the app link's person",
      r: req({ person: { ...ADA, id: 'account:u-7' }, personVia: 'app' }),
      page: true,
      verified: true,
    },
    {
      name: 'a service token, even with the page marks',
      r: req({ service: ADA, headers: FETCH_MARKS }),
      page: false,
      verified: false,
    },
    {
      name: "a reader key's program, even with the page marks",
      r: req({ reader: 'reader:companion', headers: FETCH_MARKS }),
      page: false,
      verified: false,
    },
    {
      name: "a reader key's program, even by Origin over plain http",
      r: req({ reader: 'reader:companion', headers: ORIGIN_MARK }),
      page: false,
      verified: false,
    },
  ]

  for (const mode of ['page', 'verified'] as PersonCheckMode[]) {
    for (const c of cases) {
      it(`${mode}: ${c.name}`, () => {
        setPersonCheckMode(mode)
        const expected = mode === 'page' ? c.page : c.verified
        expect(actsAsPerson(c.r)).toBe(expected)
        expect(actorField(c.r).actor.kind).toBe(expected ? 'person' : 'caller')
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
        expect(refuseUnlessPerson(c.r, res as unknown as Response)).toBe(!expected)
        if (!expected) {
          expect(res.status).toHaveBeenCalledWith(403)
          expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'person_only' })
        } else {
          expect(res.status).not.toHaveBeenCalled()
        }
      })
    }
  }

  it('starts in page mode until startup sets it', () => {
    expect(actsAsPerson(req({ headers: FETCH_MARKS }))).toBe(true)
  })

  it('verified: who a person write acts as is still the person the token names', () => {
    setPersonCheckMode('verified')
    expect(actingPerson(req({ person: ADA, personVia: 'proxy' }))).toEqual(ADA)
  })

  it('controlClaimFor: a proxy person whose claim names exactly that agent', () => {
    const proxyPerson = { person: ADA, personVia: 'proxy' as const }
    expect(controlClaimFor(req({ ...proxyPerson, controlClaim: 'a1' }), 'a1')).toBe(true)
    expect(controlClaimFor(req({ ...proxyPerson, controlClaim: 'a1' }), 'a2')).toBe(false)
    expect(controlClaimFor(req({ ...proxyPerson, controlClaim: 'a1' }), 'A1')).toBe(false)
    expect(controlClaimFor(req({ ...proxyPerson, controlClaim: null }), 'a1')).toBe(false)
    expect(controlClaimFor(req({ ...proxyPerson, controlClaim: '' }), '')).toBe(false)
    expect(controlClaimFor(req({ ...proxyPerson }), 'a1')).toBe(false)
    // Never the app link's person, a service token, or a request with no person.
    expect(controlClaimFor(req({ person: ADA, personVia: 'app', controlClaim: 'a1' }), 'a1')).toBe(
      false,
    )
    expect(controlClaimFor(req({ service: ADA, controlClaim: 'a1' }), 'a1')).toBe(false)
    expect(
      controlClaimFor(
        req({ person: ADA, personVia: 'proxy', reader: 'reader:c', controlClaim: 'a1' }),
        'a1',
      ),
    ).toBe(false)
    expect(controlClaimFor(req({ controlClaim: 'a1', headers: FETCH_MARKS }), 'a1')).toBe(false)
  })
})
