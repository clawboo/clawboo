// The runtime port file is a single shared path but more than one server can be
// alive at once (the auto-scan fallback, and a restart overlapping its
// successor). These lock in that a shutting-down instance only ever deletes its
// OWN record.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { currentBootAt, currentInitStart, currentPidNamespace } from '@clawboo/process-lookup'

import {
  getApiPortFilePath,
  getStartMarkerPath,
  readApiPortFile,
  removeApiPortFile,
  removeApiPortFileIfOwned,
  removeStartMarkerIfOwned,
  writeApiPortFile,
  writeStartMarker,
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

  it('says whether the write landed, since the clawboo command trusts only this file', () => {
    expect(writeApiPortFile(18790)).toBe(true)
    // A file where the folder should be: the write cannot land.
    fs.rmSync(home, { recursive: true, force: true })
    fs.writeFileSync(home, 'not a folder')
    expect(writeApiPortFile(18790)).toBe(false)
    fs.rmSync(home, { force: true })
    fs.mkdirSync(home)
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

// `apps/cli/src/lifecycle.ts` and this file are documented as kept in lockstep on
// port parsing. The CLI half moved to `Number.isInteger` because a corrupt
// `18790.5` reached `createConnection`, which throws ERR_SOCKET_BAD_PORT
// synchronously — but this half was left on `Number.isFinite`, so the same file
// the two halves SHARE was rejected by one and accepted by the other.
describe('readApiPortFile rejects a non-integer port (lockstep with the CLI)', () => {
  it('returns null for a fractional port rather than handing it to the socket layer', () => {
    fs.writeFileSync(path.join(home, 'api-port.txt'), '18790.5', 'utf8')
    expect(readApiPortFile()).toBeNull()
  })

  it('still accepts a normal integer port', () => {
    fs.writeFileSync(path.join(home, 'api-port.txt'), '18790', 'utf8')
    expect(readApiPortFile()).toBe(18790)
  })

  it('rejects out-of-range and non-numeric values', () => {
    for (const raw of ['0', '-1', '65536', 'abc', '']) {
      fs.writeFileSync(path.join(home, 'api-port.txt'), raw, 'utf8')
      expect(readApiPortFile()).toBeNull()
    }
  })
})

// The start marker beside the port file. Its field names are a contract an app
// that runs Clawboo reads, so every one is checked by name here.
describe('writeStartMarker', () => {
  const readMarker = () => JSON.parse(fs.readFileSync(getStartMarkerPath(), 'utf8'))

  it('writes every field, for this process, beside the port file', () => {
    expect(writeStartMarker(18790, '0.9.0')).toBe(true)
    expect(getStartMarkerPath()).toBe(path.join(home, 'api-port.json'))
    const marker = readMarker()
    expect(Object.keys(marker).sort()).toEqual(
      ['bootAt', 'initStart', 'pid', 'pidNamespace', 'port', 'startedAt', 'version'].sort(),
    )
    expect(marker.port).toBe(18790)
    expect(marker.pid).toBe(process.pid)
    expect(marker.version).toBe('0.9.0')
    expect(marker.bootAt).toBe(currentBootAt())
    expect(marker.pidNamespace).toBe(currentPidNamespace())
    expect(marker.initStart).toBe(currentInitStart())
    expect(Math.abs(marker.startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(1_000)
  })

  it('leaves the bare port file a bare integer, for older readers', () => {
    writeApiPortFile(18790)
    writeStartMarker(18790, '0.9.0')
    expect(fs.readFileSync(getApiPortFilePath(), 'utf8')).toBe('18790')
  })

  it("writes through a temp file of this process's own, renamed over the marker", () => {
    const rename = vi.spyOn(fs, 'renameSync')
    writeStartMarker(18790, '0.9.0')
    const tmp = `${getStartMarkerPath()}.${process.pid}.tmp`
    expect(rename).toHaveBeenCalledWith(tmp, getStartMarkerPath())
    expect(fs.existsSync(tmp)).toBe(false)
    expect(fs.readdirSync(home).sort()).toEqual(['api-port.json'])
    expect(readMarker().port).toBe(18790)
  })

  it('replaces a marker another server wrote whole, never leaving a mix of both', () => {
    fs.writeFileSync(
      getStartMarkerPath(),
      JSON.stringify({ port: 18791, pid: 1, startedAt: 1, bootAt: 1, version: 'x'.repeat(500) }),
    )
    writeStartMarker(18790, '0.9.0')
    expect(readMarker()).toMatchObject({ port: 18790, pid: process.pid, version: '0.9.0' })
  })

  it('still lands the marker when the rename is refused (Windows, a reader holding it)', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    expect(writeStartMarker(18790, '0.9.0')).toBe(true)
    expect(readMarker().pid).toBe(process.pid)
    expect(fs.readdirSync(home)).toEqual(['api-port.json'])
  })

  it('returns false when the folder cannot be written', () => {
    const blocker = path.join(home, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    process.env['CLAWBOO_HOME'] = blocker
    expect(writeStartMarker(18790, '0.9.0')).toBe(false)
  })
})

describe('removeStartMarkerIfOwned', () => {
  it('removes the marker when it names this process', () => {
    writeStartMarker(18790, '0.9.0')
    removeStartMarkerIfOwned()
    expect(fs.existsSync(getStartMarkerPath())).toBe(false)
  })

  it("leaves another server's marker: it is still running and still needs it", () => {
    const other = {
      port: 18791,
      pid: process.pid + 1,
      startedAt: Date.now(),
      bootAt: currentBootAt(),
      pidNamespace: null,
      initStart: null,
      version: '0.9.0',
    }
    fs.writeFileSync(getStartMarkerPath(), JSON.stringify(other))
    removeStartMarkerIfOwned()
    expect(JSON.parse(fs.readFileSync(getStartMarkerPath(), 'utf8'))).toEqual(other)
  })

  it('leaves a marker it cannot read, and does not throw when there is none', () => {
    fs.writeFileSync(getStartMarkerPath(), 'garbage')
    removeStartMarkerIfOwned()
    expect(fs.existsSync(getStartMarkerPath())).toBe(true)
    fs.rmSync(getStartMarkerPath())
    expect(() => removeStartMarkerIfOwned()).not.toThrow()
  })
})
