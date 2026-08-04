// The runtime port file is a single shared path but more than one server can be
// alive at once (the auto-scan fallback, and a restart overlapping its
// successor). These lock in that a shutting-down instance only ever deletes its
// OWN record.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getApiPortFilePath,
  readApiPortFile,
  removeApiPortFile,
  removeApiPortFileIfOwned,
  writeApiPortFile,
} from '../portUtils'

let home: string
let previousHome: string | undefined

beforeEach(() => {
  // CLAWBOO_HOME is read through `resolveClawbooDir(process.env)` on every call,
  // so pointing it at a throwaway dir keeps the developer's ~/.clawboo untouched.
  previousHome = process.env['CLAWBOO_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-porttest-'))
  process.env['CLAWBOO_HOME'] = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

describe('writeApiPortFile / readApiPortFile', () => {
  it('round-trips a port through CLAWBOO_HOME', () => {
    writeApiPortFile(18790)
    expect(getApiPortFilePath()).toBe(path.join(home, 'api-port.txt'))
    expect(readApiPortFile()).toBe(18790)
  })

  it('reads null when the file is absent or unparseable', () => {
    expect(readApiPortFile()).toBeNull()
    fs.writeFileSync(path.join(home, 'api-port.txt'), 'not-a-port', 'utf8')
    expect(readApiPortFile()).toBeNull()
  })
})

describe('removeApiPortFileIfOwned', () => {
  it('removes the file when it names our port', () => {
    writeApiPortFile(18790)
    removeApiPortFileIfOwned(18790)
    expect(readApiPortFile()).toBeNull()
    expect(fs.existsSync(path.join(home, 'api-port.txt'))).toBe(false)
  })

  // The regression: instance A on 18790 shuts down after instance B has already
  // rebound 18791 and rewritten the file. A must not strand B.
  it('leaves a file that names a different port alone', () => {
    writeApiPortFile(18791)
    removeApiPortFileIfOwned(18790)
    expect(readApiPortFile()).toBe(18791)
  })

  it('is a no-op when there is no file', () => {
    expect(() => removeApiPortFileIfOwned(18790)).not.toThrow()
    expect(readApiPortFile()).toBeNull()
  })

  it('leaves an unparseable file alone rather than guessing', () => {
    fs.writeFileSync(path.join(home, 'api-port.txt'), 'garbage', 'utf8')
    removeApiPortFileIfOwned(18790)
    expect(fs.existsSync(path.join(home, 'api-port.txt'))).toBe(true)
  })
})

describe('removeApiPortFile', () => {
  it('still removes unconditionally, and tolerates a missing file', () => {
    writeApiPortFile(18795)
    removeApiPortFile()
    expect(readApiPortFile()).toBeNull()
    expect(() => removeApiPortFile()).not.toThrow()
  })
})
