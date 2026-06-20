import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

import { findExecutable, isWindows, resolveRuntimeBin, resolveShimName } from '../platform'

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

  describe('resolveRuntimeBin', () => {
    it('resolves a PATH binary (node)', () => {
      expect(resolveRuntimeBin('node')).toBeTruthy()
    })

    it('falls back to an injected user-install dir when the tool is off PATH', () => {
      // Mirrors the Hermes case: the binary lives in a dir that is NOT on PATH
      // (its Python user-site bin), so PATH resolution misses it but the
      // extra-dir scan finds it.
      const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-bin-'))
      try {
        const file = isWindows ? 'faketool.exe' : 'faketool'
        const full = path.join(dir, file)
        writeFileSync(full, isWindows ? 'x' : '#!/bin/sh\necho hi\n')
        if (!isWindows) chmodSync(full, 0o755)
        expect(resolveRuntimeBin('faketool', [dir])).toBe(full)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('returns null when not on PATH nor the extra dirs', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-bin-empty-'))
      try {
        expect(resolveRuntimeBin('this-binary-does-not-exist-clawboo-42', [dir])).toBeNull()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
