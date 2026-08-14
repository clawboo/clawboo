import { describe, expect, it } from 'vitest'

import {
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
  isSupportedNodeVersion,
  nodeVersionError,
  parseNodeVersion,
} from '../node-version'

describe('node-version preflight', () => {
  it('parses a process.version-shaped string', () => {
    expect(parseNodeVersion('v22.12.0')).toEqual({ major: 22, minor: 12 })
    expect(parseNodeVersion('24.3.1')).toEqual({ major: 24, minor: 3 })
    expect(parseNodeVersion('not-a-version')).toBeNull()
  })

  it('accepts the floor and anything newer', () => {
    expect(isSupportedNodeVersion(`v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`)).toBe(true)
    expect(isSupportedNodeVersion('v22.20.0')).toBe(true)
    expect(isSupportedNodeVersion('v24.0.0')).toBe(true)
  })

  it('rejects the versions that actually break the bundled CJS launcher', () => {
    // 22.0–22.11 predate `require(esm)`, so requiring ESM-only chalk/ora throws.
    expect(isSupportedNodeVersion('v22.0.0')).toBe(false)
    expect(isSupportedNodeVersion('v22.11.0')).toBe(false)
    expect(isSupportedNodeVersion('v20.18.0')).toBe(false)
  })

  it('fails open on an unrecognised runtime rather than blocking a launch', () => {
    expect(isSupportedNodeVersion('weird-build')).toBe(true)
    expect(nodeVersionError('weird-build')).toBeNull()
  })

  it('returns an actionable message below the floor, null at or above it', () => {
    const msg = nodeVersionError('v20.18.0')
    expect(msg).toContain('requires Node.js')
    expect(msg).toContain('v20.18.0')
    expect(msg).toContain('nodejs.org')
    expect(nodeVersionError('v22.12.0')).toBeNull()
  })
})
