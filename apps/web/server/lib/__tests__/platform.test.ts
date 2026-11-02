import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, it, expect } from 'vitest'

import {
  findExecutable,
  isWindows,
  pickPython,
  pythonCandidateNames,
  resolvePython,
  resolveRuntimeBin,
  resolveShimName,
  type PythonCandidate,
} from '../platform'

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

  // The selection behind the Hermes pip install. hermes-agent requires
  // >=3.11,<3.14: on a fresh macOS the default `python3` is the Xcode CLT Python
  // 3.9 (too old), and on a machine with Homebrew's newest Python it is 3.14 (too
  // new). Either way pip reports "(from versions: none)".
  const HERMES_RANGE = { minMinor: 11, maxMinor: 13 }

  describe('pickPython', () => {
    const py = (minor: number, bin = `/usr/bin/python3.${minor}`): PythonCandidate => ({
      bin,
      minor,
      version: `3.${minor}`,
    })
    const XCODE = py(9, '/Applications/Xcode.app/Contents/Developer/usr/bin/python3')

    it('picks the newest interpreter inside the range', () => {
      expect(pickPython([py(9), py(12), py(11)], HERMES_RANGE)?.minor).toBe(12)
    })

    it('does not let a Python 3.14 beat an installed 3.12', () => {
      expect(pickPython([py(14), py(12), py(9)], HERMES_RANGE)?.minor).toBe(12)
    })

    it('returns null when every interpreter is outside the range', () => {
      expect(pickPython([XCODE, py(14)], HERMES_RANGE)).toBeNull()
    })

    it('uses a version-specific 3.11 when the default python3 is the old Xcode one', () => {
      const picked = pickPython([XCODE, py(11, '/opt/homebrew/bin/python3.11')], HERMES_RANGE)
      expect(picked?.bin).toContain('python3.11')
    })

    it('returns null when nothing was found', () => {
      expect(pickPython([], HERMES_RANGE)).toBeNull()
    })

    it('with no bounds accepts any interpreter, newest wins', () => {
      expect(pickPython([py(9), py(14)], { minMinor: 0, maxMinor: Infinity })?.minor).toBe(14)
    })
  })

  describe('pythonCandidateNames', () => {
    it('probes one step past each end of the range, newest first, then the bare names', () => {
      expect(pythonCandidateNames(HERMES_RANGE)).toEqual([
        'python3.14',
        'python3.13',
        'python3.12',
        'python3.11',
        'python3.10',
        'python3',
        'python',
      ])
    })

    it('probes only the bare names when the range has no top', () => {
      expect(pythonCandidateNames({ minMinor: 11, maxMinor: Infinity })).toEqual([
        'python3',
        'python',
      ])
    })
  })

  // Real probing against fake interpreters on PATH: each script prints the minor
  // version the real `-c` one-liner would print, or exits 1 (not a usable Python).
  describe.skipIf(isWindows)('resolvePython', () => {
    let dir: string
    let prevPath: string | undefined

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-py-'))
      prevPath = process.env['PATH']
      // The fakes shadow every probed name; /usr/bin and /bin keep `which` working.
      process.env['PATH'] = [dir, '/usr/bin', '/bin'].join(path.delimiter)
    })

    afterEach(() => {
      process.env['PATH'] = prevPath
      rmSync(dir, { recursive: true, force: true })
    })

    function fakePython(name: string, minor: number | null): void {
      const full = path.join(dir, name)
      writeFileSync(full, minor === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho ${minor}\n`)
      chmodSync(full, 0o755)
    }

    it('takes the installed 3.12 over a newer 3.14 that is also the default python3', () => {
      fakePython('python3.14', 14)
      fakePython('python3.13', null)
      fakePython('python3.12', 12)
      fakePython('python3.11', null)
      fakePython('python3.10', null)
      fakePython('python3', 14)
      fakePython('python', 14)
      const { compatible, found } = resolvePython(HERMES_RANGE)
      expect(compatible?.bin).toBe(path.join(dir, 'python3.12'))
      expect(found.map((c) => c.minor)).toEqual([14, 14, 14, 12])
    })

    it('reports every out-of-range Python it found when none fits', () => {
      fakePython('python3.14', 14)
      fakePython('python3.13', null)
      fakePython('python3.12', null)
      fakePython('python3.11', null)
      fakePython('python3.10', 10)
      fakePython('python3', 9)
      fakePython('python', null)
      const { compatible, found } = resolvePython(HERMES_RANGE)
      expect(compatible).toBeNull()
      expect(found.map((c) => c.version)).toEqual(['3.14', '3.10', '3.9'])
    })
  })
})
