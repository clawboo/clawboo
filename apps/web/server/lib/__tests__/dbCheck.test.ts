// The boot probe's SQLite check runs in a worker thread on its own read-only
// connection, so a long check never freezes the server's event loop, and it still
// reports what SQLite found.

import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb, openDb, type ClawbooDb } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkDatabase } from '../dbCheck'

let dir: string
let file: string
const open: ClawbooDb[] = []

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-dbcheck-'))
  file = path.join(dir, 'clawboo.db')
})

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.$client.close()
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('checkDatabase', () => {
  it('runs the quick and the full check in a worker and passes a sound database', async () => {
    const db = createDb(file)
    open.push(db)
    expect(await checkDatabase(file, 'quick_check')).toEqual({ ran: true, verdict: 'ok' })
    expect(await checkDatabase(file, 'integrity_check')).toEqual({ ran: true, verdict: 'ok' })
  })

  it('reports damage SQLite finds in the file', async () => {
    const seed = openDb(file)
    seed.$client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)')
    const insert = seed.$client.prepare('INSERT INTO t (body) VALUES (?)')
    seed.$client.transaction(() => {
      for (let i = 0; i < 2_000; i++) insert.run('x'.repeat(200))
    })()
    seed.$client.pragma('wal_checkpoint(TRUNCATE)')
    const pageSize = Number(seed.$client.pragma('page_size', { simple: true }))
    seed.$client.close()

    // Scribble over the middle of the table's pages, leaving the file header alone.
    const fd = openSync(file, 'r+')
    writeSync(fd, Buffer.alloc(pageSize, 0xab), 0, pageSize, pageSize * 5)
    closeSync(fd)

    const result = await checkDatabase(file, 'quick_check')
    expect(result.ran).toBe(true)
    expect(result.ran && result.verdict).not.toBe('ok')
  })

  it('says the check could not run, rather than running it on the main thread, when the worker cannot open the file', async () => {
    const result = await checkDatabase(path.join(dir, 'missing.db'), 'quick_check')
    expect(result.ran).toBe(false)
  })

  it('says the check could not run when it outlasts its time limit', async () => {
    const db = createDb(file)
    open.push(db)
    const result = await checkDatabase(file, 'integrity_check', { timeoutMs: 1 })
    expect(result).toEqual({ ran: false, reason: 'timed out after 0 s' })
  })
})
