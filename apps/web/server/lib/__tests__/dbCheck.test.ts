// The boot probe's SQLite check runs in a worker thread on its own read-only
// connection, so a long check never freezes the server's event loop, and it still
// reports what SQLite found.

import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb, openDb, type ClawbooDb } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkDatabase, checkDatabaseInThread } from '../dbCheck'

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
    expect(await checkDatabase(db, file, 'quick_check')).toEqual({ verdict: 'ok', offThread: true })
    expect(await checkDatabase(db, file, 'integrity_check')).toEqual({
      verdict: 'ok',
      offThread: true,
    })
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

    const db = openDb(file)
    open.push(db)
    const result = await checkDatabase(db, file, 'quick_check')
    expect(result.offThread).toBe(true)
    expect(result.verdict).not.toBe('ok')
  })

  it('falls back to the given connection when the worker cannot open the file', async () => {
    const db = createDb(file)
    open.push(db)
    const result = await checkDatabase(db, path.join(dir, 'missing.db'), 'quick_check')
    expect(result).toEqual({ verdict: 'ok', offThread: false })
  })

  it('checkDatabaseInThread reads the verdict on the calling thread', () => {
    const db = createDb(file)
    open.push(db)
    expect(checkDatabaseInThread(db, 'quick_check')).toBe('ok')
  })
})
