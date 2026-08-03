import { describe, expect, it } from 'vitest'

import { isDevVersion, semverGt, shouldOfferRestart } from '../versionCheck'

describe('semverGt', () => {
  it('compares major.minor.patch', () => {
    expect(semverGt('0.3.1', '0.3.0')).toBe(true)
    expect(semverGt('0.3.0', '0.3.1')).toBe(false)
    expect(semverGt('0.3.0', '0.3.0')).toBe(false)
    expect(semverGt('1.0.0', '0.9.9')).toBe(true)
  })

  it('compares numerically, not lexicographically', () => {
    expect(semverGt('0.10.0', '0.9.0')).toBe(true)
    expect(semverGt('0.9.0', '0.10.0')).toBe(false)
    expect(semverGt('0.3.10', '0.3.9')).toBe(true)
  })

  it('treats a release as greater than a prerelease of the same core', () => {
    expect(semverGt('1.0.0', '1.0.0-beta.1')).toBe(true)
    expect(semverGt('1.0.0-beta.1', '1.0.0')).toBe(false)
    expect(semverGt('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true)
    expect(semverGt('1.0.0-beta.1', '1.0.0-beta.1')).toBe(false)
  })

  it('tolerates a leading v', () => {
    expect(semverGt('v0.3.1', '0.3.0')).toBe(true)
    expect(semverGt('0.3.1', 'v0.3.0')).toBe(true)
  })

  it('fails safe on unparseable input', () => {
    expect(semverGt('garbage', '0.3.0')).toBe(false)
    expect(semverGt('0.3.0', 'garbage')).toBe(false)
    expect(semverGt('', '0.3.0')).toBe(false)
    expect(semverGt('0.3', '0.2.0')).toBe(false)
  })
})

describe('isDevVersion', () => {
  it('recognizes the 0.0.0 dev family', () => {
    expect(isDevVersion('0.0.0-dev')).toBe(true)
    expect(isDevVersion('0.0.0')).toBe(true)
  })

  it('is deliberately narrow — 0.0.1 is a real release', () => {
    expect(isDevVersion('0.0.1')).toBe(false)
    expect(isDevVersion('0.3.1')).toBe(false)
  })
})

describe('shouldOfferRestart', () => {
  it('offers when this launcher is strictly newer than the running server', () => {
    expect(shouldOfferRestart('0.3.1', '0.3.0')).toBe(true)
    expect(shouldOfferRestart('0.4.0', '0.3.9')).toBe(true)
  })

  it('never offers a downgrade', () => {
    expect(shouldOfferRestart('0.3.0', '0.3.1')).toBe(false)
  })

  it('stays quiet when the versions match', () => {
    expect(shouldOfferRestart('0.3.1', '0.3.1')).toBe(false)
  })

  it('never nags from a dev checkout', () => {
    expect(shouldOfferRestart('0.0.0-dev', '0.3.0')).toBe(false)
  })

  // The important one: a globally-installed clawboo must never offer to SIGTERM
  // a contributor's `pnpm dev` server, which reports itself as 0.0.0-dev.
  it('never targets a dev server', () => {
    expect(shouldOfferRestart('0.3.1', '0.0.0-dev')).toBe(false)
    expect(shouldOfferRestart('0.3.1', '0.0.0')).toBe(false)
  })

  it('attaches silently when the version could not be read', () => {
    expect(shouldOfferRestart('0.3.1', null)).toBe(false)
  })

  it('attaches silently on an unparseable server version', () => {
    expect(shouldOfferRestart('0.3.1', 'not-a-version')).toBe(false)
  })
})
