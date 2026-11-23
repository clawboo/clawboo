// Where an agent's display keeps its files: a runtime folder in memory, closed
// to everyone but its user, when that user has one. The filesystem is stood in
// for, so these run anywhere.

import type fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  displayRuntimeRoot,
  isRuntimeDirFor,
  userRuntimeDir,
  type RuntimeDirDeps,
} from '../runtimeDir'

const TMPFS = 0x01021994
const EXT4 = 0xef53

interface Dir {
  uid: number
  mode: number
  type: number
  link?: boolean
}

function fakeFs(dirs: Record<string, Dir>): RuntimeDirDeps {
  const find = (p: string): Dir => {
    const d = dirs[p]
    if (!d) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return d
  }
  return {
    lstat: (p) => {
      const d = find(p)
      return {
        uid: d.uid,
        mode: d.mode,
        isDirectory: () => !d.link,
      } as unknown as fs.Stats
    },
    fsType: (p) => find(p).type,
  }
}

describe('isRuntimeDirFor', () => {
  it('takes a 0700 folder of that user on tmpfs', () => {
    const deps = fakeFs({ '/run/user/1000': { uid: 1000, mode: 0o40700, type: TMPFS } })
    expect(isRuntimeDirFor('/run/user/1000', 1000, deps)).toBe(true)
  })

  it("refuses another user's folder, an open one, a disk one, a link, or none", () => {
    const cases: [Record<string, Dir>, number][] = [
      [{ '/run/user/1000': { uid: 1001, mode: 0o700, type: TMPFS } }, 1000],
      [{ '/run/user/1000': { uid: 1000, mode: 0o750, type: TMPFS } }, 1000],
      [{ '/run/user/1000': { uid: 1000, mode: 0o701, type: TMPFS } }, 1000],
      [{ '/run/user/1000': { uid: 1000, mode: 0o700, type: EXT4 } }, 1000],
      [{ '/run/user/1000': { uid: 1000, mode: 0o700, type: TMPFS, link: true } }, 1000],
      [{}, 1000],
    ]
    for (const [dirs, uid] of cases) {
      expect(isRuntimeDirFor('/run/user/1000', uid, fakeFs(dirs))).toBe(false)
    }
  })

  it('refuses a path that is not written plainly', () => {
    const deps = fakeFs({ '/run/user/1000': { uid: 1000, mode: 0o700, type: TMPFS } })
    expect(isRuntimeDirFor('/run/user/../user/1000', 1000, deps)).toBe(false)
    expect(isRuntimeDirFor('run/user/1000', 1000, deps)).toBe(false)
  })
})

describe('displayRuntimeRoot', () => {
  const runtime = (uid: number, type = TMPFS): Dir => ({ uid, mode: 0o700, type })

  it("looks at the server's own XDG_RUNTIME_DIR first, then /run/user/<uid>", () => {
    const deps = fakeFs({ '/run/clawboo': runtime(1000), '/run/user/1000': runtime(1000) })
    const env = { XDG_RUNTIME_DIR: '/run/clawboo' }
    expect(displayRuntimeRoot(1000, { serverUser: true, env }, deps)).toBe('/run/clawboo')
    expect(displayRuntimeRoot(1000, { serverUser: true, env: {} }, deps)).toBe('/run/user/1000')
    // An XDG_RUNTIME_DIR that fails the check is passed over, not trusted.
    const bad = fakeFs({
      '/tmp': { uid: 0, mode: 0o1777, type: TMPFS },
      '/run/user/1000': runtime(1000),
    })
    expect(
      displayRuntimeRoot(1000, { serverUser: true, env: { XDG_RUNTIME_DIR: '/tmp' } }, bad),
    ).toBe('/run/user/1000')
  })

  it("for an agent user, only that user's /run/user folder, never the server's environment", () => {
    const deps = fakeFs({ '/run/clawboo': runtime(1000), '/run/user/2001': runtime(2001) })
    const env = { XDG_RUNTIME_DIR: '/run/clawboo' }
    expect(displayRuntimeRoot(2001, { serverUser: false, env }, deps)).toBe('/run/user/2001')
    expect(displayRuntimeRoot(2002, { serverUser: false, env }, deps)).toBeNull()
  })

  it('is null without a uid, or with no runtime folder (the stated fallback applies)', () => {
    const deps = fakeFs({ '/run/user/1000': runtime(1000, EXT4) })
    expect(displayRuntimeRoot(null, { serverUser: true, env: {} }, deps)).toBeNull()
    expect(displayRuntimeRoot(1000, { serverUser: true, env: {} }, deps)).toBeNull()
    expect(userRuntimeDir(1000)).toBe('/run/user/1000')
  })
})
