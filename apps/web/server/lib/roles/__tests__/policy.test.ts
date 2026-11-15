// What each role may do, read from a token's claims. Pure: no Express, no database.

import { describe, expect, it } from 'vitest'

import {
  accessEnded,
  accessFromClaims,
  guestTeams,
  isGuestOnly,
  permissionsOf,
  rolesOf,
  sortedPermissions,
  type PersonAccess,
} from '../policy'

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0)

function access(over: Partial<PersonAccess>): PersonAccess {
  return {
    roles: [],
    approve: false,
    teams: null,
    until: null,
    label: null,
    service: false,
    ...over,
  }
}

function perms(a: PersonAccess, now = NOW): string[] {
  return sortedPermissions(permissionsOf(a, now))
}

describe('rolesOf', () => {
  it('reads one role or a list, ignores words it does not know, and folds case', () => {
    expect(rolesOf('owner')).toEqual(['owner'])
    expect(rolesOf(' Operator ')).toEqual(['operator'])
    expect(rolesOf(['offline_access', 'member', 'uma_authorization'])).toEqual(['member'])
    expect(rolesOf(['guest', 'owner'])).toEqual(['owner', 'guest'])
  })

  it('finds no role in nothing, a number or an unknown word', () => {
    expect(rolesOf(undefined)).toEqual([])
    expect(rolesOf(42)).toEqual([])
    expect(rolesOf('admin')).toEqual([])
    expect(rolesOf([])).toEqual([])
  })
})

describe('accessFromClaims', () => {
  it('reads the role and the claims beside it', () => {
    expect(
      accessFromClaims('guest', {
        teams: ['t-1', 't-2'],
        access_until: 1_795_000_000,
        roleLabel: 'Expert',
      }),
    ).toEqual({
      roles: ['guest'],
      approve: false,
      teams: ['t-1', 't-2'],
      until: 1_795_000_000,
      label: 'Expert',
      service: false,
    })
    expect(accessFromClaims('member', { approve: true })?.approve).toBe(true)
  })

  it('takes a token with no claims beside its role, and one with no role at all', () => {
    expect(accessFromClaims('owner', {})).toEqual(access({ roles: ['owner'] }))
    expect(accessFromClaims(undefined, {})).toEqual(access({}))
  })

  it('refuses a claim that is there but malformed, rather than reading it as no limit', () => {
    expect(accessFromClaims('member', { approve: 'yes' })).toBeNull()
    expect(accessFromClaims('guest', { teams: 't-1' })).toBeNull()
    expect(accessFromClaims('guest', { teams: [1] })).toBeNull()
    expect(accessFromClaims('guest', { teams: [''] })).toBeNull()
    expect(accessFromClaims('guest', { teams: [' t-1'] })).toBeNull()
    expect(accessFromClaims('guest', { teams: ['t\n1'] })).toBeNull()
    expect(accessFromClaims('guest', { access_until: '2026-12-01' })).toBeNull()
    expect(accessFromClaims('guest', { access_until: Number.NaN })).toBeNull()
  })

  it('takes a team id of up to 128 characters and refuses a longer one', () => {
    expect(accessFromClaims('guest', { teams: ['t'.repeat(128)] })?.teams).toHaveLength(1)
    expect(accessFromClaims('guest', { teams: ['t'.repeat(129)] })).toBeNull()
  })

  it('takes up to 64 teams and refuses more', () => {
    const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
    expect(accessFromClaims('guest', { teams: teams(64) })?.teams).toHaveLength(64)
    expect(accessFromClaims('guest', { teams: teams(65) })).toBeNull()
  })

  it('reads a token without a version as version 1, and refuses one it does not know', () => {
    expect(accessFromClaims('owner', { rv: 1 })?.roles).toEqual(['owner'])
    expect(accessFromClaims('owner', {})?.roles).toEqual(['owner'])
    expect(accessFromClaims('owner', { rv: 2 })).toBeNull()
    expect(accessFromClaims('owner', { rv: '1' })).toBeNull()
  })

  it('reads a service token, and refuses an svc that is not true or false', () => {
    expect(accessFromClaims('operator', { svc: true })?.service).toBe(true)
    expect(accessFromClaims('operator', {})?.service).toBe(false)
    expect(accessFromClaims('operator', { svc: 'yes' })).toBeNull()
  })

  it("reads a guest's end only from access_until, never from until", () => {
    expect(accessFromClaims('guest', { until: 1 })?.until).toBeNull()
    expect(accessFromClaims('guest', { access_until: 1 })?.until).toBe(1)
  })

  it('cleans a label and drops one that is not text', () => {
    expect(accessFromClaims('guest', { roleLabel: '  Ex\u0007pert ' })?.label).toBe('Expert')
    expect(accessFromClaims('guest', { roleLabel: 7 })?.label).toBeNull()
  })
})

describe('permissionsOf', () => {
  it('lets an owner answer approvals and make them standing, but not run the system', () => {
    expect(perms(access({ roles: ['owner'] }))).toEqual([
      'see',
      'work',
      'tighten',
      'accounts',
      'approve',
      'standing',
      'records',
    ])
  })

  it('lets an operator set up and run everything, but never answer an approval', () => {
    const p = perms(access({ roles: ['operator'] }))
    expect(p).toEqual(['see', 'work', 'tighten', 'accounts', 'setup', 'costs', 'system', 'records'])
    expect(p).not.toContain('approve')
    expect(p).not.toContain('standing')
  })

  it('lets a member approve only when the token says so', () => {
    expect(perms(access({ roles: ['member'] }))).toEqual(['see', 'work'])
    expect(perms(access({ roles: ['member'], approve: true }))).toEqual(['see', 'work', 'approve'])
  })

  it('never lets a guest approve, whatever the token says', () => {
    expect(perms(access({ roles: ['guest'], approve: true }))).toEqual(['see', 'work'])
  })

  it('adds roles up', () => {
    expect(perms(access({ roles: ['owner', 'operator'] }))).toEqual([
      'see',
      'work',
      'tighten',
      'accounts',
      'approve',
      'standing',
      'setup',
      'costs',
      'system',
      'records',
    ])
  })

  it('never lets a service token answer or make an approval, whatever its role', () => {
    expect(perms(access({ roles: ['owner'], service: true }))).toEqual([
      'see',
      'work',
      'tighten',
      'accounts',
      'records',
    ])
    expect(perms(access({ roles: ['member'], approve: true, service: true }))).toEqual([
      'see',
      'work',
    ])
  })

  it('gives nothing to a token with no role it knows', () => {
    expect(perms(access({}))).toEqual([])
  })

  it("gives a guest nothing once their access has ended, and only a guest's ends", () => {
    const until = NOW / 1000
    expect(perms(access({ roles: ['guest'], teams: ['t'], until }), NOW - 1)).toEqual([
      'see',
      'work',
    ])
    expect(perms(access({ roles: ['guest'], teams: ['t'], until }), NOW)).toEqual([])
    expect(accessEnded(access({ roles: ['guest'], until }), NOW)).toBe(true)
    // A broader role is not cut off by `until`: the claim is a guest's limit.
    expect(perms(access({ roles: ['member'], until }), NOW)).toEqual(['see', 'work'])
    expect(accessEnded(access({ roles: ['member', 'guest'], until }), NOW)).toBe(false)
  })
})

describe('guest limits', () => {
  it('hold only while guest is the one role', () => {
    expect(isGuestOnly(access({ roles: ['guest'] }))).toBe(true)
    expect(isGuestOnly(access({ roles: ['member', 'guest'] }))).toBe(false)
    expect(guestTeams(access({ roles: ['member', 'guest'], teams: ['t'] }))).toBeNull()
  })

  it('reach the teams the token names, and none when it names none', () => {
    expect([...(guestTeams(access({ roles: ['guest'], teams: ['a', 'b'] })) ?? [])]).toEqual([
      'a',
      'b',
    ])
    expect(guestTeams(access({ roles: ['guest'] }))?.size).toBe(0)
  })
})
