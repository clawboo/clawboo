import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SERVER_LOG_MAX_BYTES,
  openServerLog,
  resolveServerLogPath,
  tailServerLog,
} from '../server-log'

describe('server-log', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-log-'))
    prevHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('opens an appendable log under the Clawboo home and writes the header', () => {
    const log = openServerLog('--- header ---\n')
    expect(log).not.toBeNull()
    expect(log!.path).toBe(resolveServerLogPath())
    fs.writeSync(log!.fd, 'boot line\n')
    fs.closeSync(log!.fd)
    expect(fs.readFileSync(log!.path, 'utf8')).toContain('--- header ---')
    expect(fs.readFileSync(log!.path, 'utf8')).toContain('boot line')
  })

  it('rotates a log that has grown past the cap', () => {
    const logPath = resolveServerLogPath()
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, 'x'.repeat(SERVER_LOG_MAX_BYTES + 1))

    const log = openServerLog()
    expect(log).not.toBeNull()
    fs.closeSync(log!.fd)

    expect(fs.existsSync(`${logPath}.1`)).toBe(true) // previous log preserved
    expect(fs.statSync(logPath).size).toBeLessThan(SERVER_LOG_MAX_BYTES) // fresh log
  })

  it('tails only the last non-blank lines', () => {
    const log = openServerLog()!
    fs.writeSync(log.fd, 'one\n\ntwo\nthree\n')
    fs.closeSync(log.fd)
    expect(tailServerLog(log.path, 2)).toEqual(['two', 'three'])
  })

  it('degrades quietly when the log is missing', () => {
    expect(tailServerLog(path.join(home, 'nope.log'))).toEqual([])
  })
})
