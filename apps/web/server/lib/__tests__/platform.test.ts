import { describe, it, expect } from 'vitest'

import { findExecutable, isWindows, resolveShimName } from '../platform'

describe('platform helper', () => {
  describe('isWindows', () => {
    it('reflects process.platform', () => {
      expect(isWindows).toBe(process.platform === 'win32')
    })
  })

  describe('resolveShimName', () => {
    it('appends .cmd on Windows', () => {
      if (isWindows) {
        expect(resolveShimName('npm')).toBe('npm.cmd')
        expect(resolveShimName('openclaw')).toBe('openclaw.cmd')
        expect(resolveShimName('pnpm')).toBe('pnpm.cmd')
      } else {
        expect(resolveShimName('npm')).toBe('npm')
        expect(resolveShimName('openclaw')).toBe('openclaw')
        expect(resolveShimName('pnpm')).toBe('pnpm')
      }
    })
  })

  describe('findExecutable', () => {
    it('finds a known binary that always exists (node)', () => {
      // `node` is on PATH wherever this test runs — it's how vitest is
      // invoked. So findExecutable('node') MUST return a non-null path
      // on every platform.
      const result = findExecutable('node')
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
      // The returned path must contain the binary name (case-insensitive
      // on Windows, exact match elsewhere).
      expect(result!.toLowerCase()).toContain('node')
    })

    it('returns null for nonsense names (does not throw)', () => {
      const result = findExecutable('this-binary-definitely-does-not-exist-clawboo-test-42')
      expect(result).toBeNull()
    })
  })
})
