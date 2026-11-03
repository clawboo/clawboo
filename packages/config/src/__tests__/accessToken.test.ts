// The per-install access token: where the server and the CLI get the dashboard's
// token when STUDIO_ACCESS_TOKEN is not set. Real filesystem throughout; the mode
// assertions are POSIX-only, since Windows has no group/other bits.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACCESS_TOKEN_FILENAME,
  findUnsupportedTokenChar,
  readAccessTokenFile,
  resolveAccessToken,
  resolveAccessTokenPath,
} from '../index'

const posixOnly = it.skipIf(process.platform === 'win32')
const modeOf = (p: string): number => statSync(p).mode & 0o777
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

let tmp: string
let home: string
let file: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'clawboo-access-token-'))
  home = path.join(tmp, '.clawboo')
  file = path.join(home, ACCESS_TOKEN_FILENAME)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

/** An environment with no STUDIO_ACCESS_TOKEN at all, pointed at the sandbox. */
const unsetEnv = (): NodeJS.ProcessEnv => ({ CLAWBOO_HOME: home })

function writeTokenFile(contents: string, mode = 0o600): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(file, contents)
  chmodSync(file, mode)
}

describe('resolveAccessTokenPath', () => {
  it('is access-token in the Clawboo home', () => {
    expect(resolveAccessTokenPath({ CLAWBOO_HOME: home })).toBe(file)
  })
})

describe('resolveAccessToken: STUDIO_ACCESS_TOKEN comes first', () => {
  it('uses a set variable, trimmed, and never touches the file', () => {
    const resolved = resolveAccessToken({
      env: { CLAWBOO_HOME: home, STUDIO_ACCESS_TOKEN: '  from-env  ' },
    })
    expect(resolved).toEqual({ source: 'env', token: 'from-env' })
    expect(existsSync(file)).toBe(false)
  })

  it('wins over an existing file', () => {
    writeTokenFile('from-file')
    const resolved = resolveAccessToken({
      env: { CLAWBOO_HOME: home, STUDIO_ACCESS_TOKEN: 'from-env' },
    })
    expect(resolved).toEqual({ source: 'env', token: 'from-env' })
  })

  it('hands a token with an unsupported character back as is, for the caller to refuse', () => {
    const resolved = resolveAccessToken({
      env: { CLAWBOO_HOME: home, STUDIO_ACCESS_TOKEN: 'has/slash' },
    })
    expect(resolved).toEqual({ source: 'env', token: 'has/slash' })
  })

  for (const blank of ['', '   ']) {
    it(`treats a blank variable (${JSON.stringify(blank)}) as "no gate" and writes no file`, () => {
      const resolved = resolveAccessToken({
        env: { CLAWBOO_HOME: home, STUDIO_ACCESS_TOKEN: blank },
      })
      expect(resolved).toEqual({ source: 'off' })
      expect(existsSync(file)).toBe(false)
    })
  }

  it('ignores the file when the variable is blank', () => {
    writeTokenFile('from-file')
    expect(resolveAccessToken({ env: { CLAWBOO_HOME: home, STUDIO_ACCESS_TOKEN: '' } })).toEqual({
      source: 'off',
    })
  })
})

describe('resolveAccessToken: the shared file', () => {
  it('creates a random base64url token when there is none', () => {
    const resolved = resolveAccessToken({ env: unsetEnv() })
    expect(resolved.source).toBe('file')
    if (resolved.source !== 'file') return
    expect(resolved.created).toBe(true)
    expect(resolved.file).toBe(file)
    expect(resolved.token).toMatch(TOKEN_SHAPE)
    // The raw token, no newline, so the desktop app and this server read the same bytes.
    expect(readFileSync(file, 'utf8')).toBe(resolved.token)
    expect(findUnsupportedTokenChar(resolved.token)).toBeNull()
  })

  posixOnly('creates the file 0600 and a missing folder 0700', () => {
    resolveAccessToken({ env: unsetEnv() })
    expect(modeOf(file)).toBe(0o600)
    expect(modeOf(home)).toBe(0o700)
  })

  it('makes a different token for a different install', () => {
    const first = resolveAccessToken({ env: unsetEnv() })
    rmSync(home, { recursive: true, force: true })
    const second = resolveAccessToken({ env: unsetEnv() })
    expect(first.source === 'file' && second.source === 'file').toBe(true)
    if (first.source !== 'file' || second.source !== 'file') return
    expect(second.token).not.toBe(first.token)
  })

  it('reuses the file on the next start', () => {
    const first = resolveAccessToken({ env: unsetEnv() })
    const second = resolveAccessToken({ env: unsetEnv() })
    expect(second).toEqual({ ...first, created: false })
  })

  it('reads a token another app wrote, trimmed', () => {
    writeTokenFile('desktop-wrote-this_123\n')
    expect(resolveAccessToken({ env: unsetEnv() })).toEqual({
      source: 'file',
      token: 'desktop-wrote-this_123',
      file,
      created: false,
    })
  })

  it('takes the Clawboo home from the option over the environment', () => {
    const other = path.join(tmp, 'other-home')
    const resolved = resolveAccessToken({ env: unsetEnv(), clawbooHome: other })
    expect(resolved.source === 'file' && resolved.file).toBe(
      path.join(other, ACCESS_TOKEN_FILENAME),
    )
    expect(existsSync(file)).toBe(false)
  })

  posixOnly('narrows a file others can read to 0600 before using it', () => {
    writeTokenFile('readable-token', 0o644)
    const resolved = resolveAccessToken({ env: unsetEnv() })
    expect(resolved.source === 'file' && resolved.token).toBe('readable-token')
    expect(modeOf(file)).toBe(0o600)
  })

  posixOnly('refuses a file that stays readable by others', () => {
    writeTokenFile('readable-token', 0o644)
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    expect(() => resolveAccessToken({ env: unsetEnv() })).toThrow(/readable by other users/)
  })

  it('refuses a file whose token the gate cannot use, and leaves it alone', () => {
    writeTokenFile('not/a+token=')
    expect(() => resolveAccessToken({ env: unsetEnv() })).toThrow(/not a usable token/)
    expect(readFileSync(file, 'utf8')).toBe('not/a+token=')
  })

  it('refuses an empty file, and leaves it alone', () => {
    writeTokenFile('')
    expect(() => resolveAccessToken({ env: unsetEnv(), retryEmptyMs: 0 })).toThrow(
      /not a usable token/,
    )
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  it('names the file and the way out in the error', () => {
    writeTokenFile('bad token')
    let message = ''
    try {
      resolveAccessToken({ env: unsetEnv() })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain(file)
    expect(message).toContain('STUDIO_ACCESS_TOKEN')
  })

  posixOnly('refuses a symbolic link in place of the file', () => {
    mkdirSync(home, { recursive: true })
    const target = path.join(tmp, 'elsewhere')
    writeFileSync(target, 'linked-token')
    chmodSync(target, 0o600)
    symlinkSync(target, file)
    expect(() => resolveAccessToken({ env: unsetEnv() })).toThrow(/not a regular file/)
  })

  it('refuses a folder in place of the file', () => {
    mkdirSync(file, { recursive: true })
    expect(() => resolveAccessToken({ env: unsetEnv() })).toThrow(/not a regular file/)
  })

  it('uses the token another app wrote first when both start at once', () => {
    // The desktop app writes the file between our read (nothing there) and our
    // exclusive create: the create fails with EEXIST, and its token wins.
    const realWrite = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((target, data, options) => {
      writeTokenFile('desktop-won-the-race')
      return realWrite(target, data, options as fs.WriteFileOptions)
    })
    expect(resolveAccessToken({ env: unsetEnv() })).toEqual({
      source: 'file',
      token: 'desktop-won-the-race',
      file,
      created: false,
    })
  })
})

describe('readAccessTokenFile (the CLI side: read only)', () => {
  it('is null when there is no file, and creates none', () => {
    expect(readAccessTokenFile({ env: unsetEnv() })).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('returns the token the server wrote', () => {
    const resolved = resolveAccessToken({ env: unsetEnv() })
    expect(readAccessTokenFile({ env: unsetEnv() })).toBe(
      resolved.source === 'file' ? resolved.token : 'unexpected',
    )
  })

  it('is null for a file the gate could not use', () => {
    writeTokenFile('bad token')
    expect(readAccessTokenFile({ env: unsetEnv() })).toBeNull()
  })

  posixOnly('is null for a file that stays readable by others', () => {
    writeTokenFile('readable-token', 0o644)
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    expect(readAccessTokenFile({ env: unsetEnv() })).toBeNull()
  })
})

describe('findUnsupportedTokenChar', () => {
  it('accepts the gate charset and a blank value', () => {
    expect(findUnsupportedTokenChar('A1b2._~-token')).toBeNull()
    expect(findUnsupportedTokenChar('')).toBeNull()
    expect(findUnsupportedTokenChar(undefined)).toBeNull()
  })

  it('names the first character it cannot use', () => {
    expect(findUnsupportedTokenChar('q8Zr/Xk1Lw==')).toBe('/')
  })
})
