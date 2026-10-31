// `clawboo backup` writes a copy of the database only its owner can read. The mode
// assertions are POSIX-only: Windows has no group/other bits.

import fs from 'fs'
import os from 'os'
import path from 'path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeDatabaseBackup } from '../backup'

const posixOnly = it.skipIf(process.platform === 'win32')
const modeOf = (p: string): number => fs.statSync(p).mode & 0o777

describe('writeDatabaseBackup', () => {
  let tmp: string
  let source: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-backup-'))
    source = path.join(tmp, 'clawboo.db')
    const db = new Database(source)
    db.pragma('journal_mode = WAL')
    db.exec("CREATE TABLE boards (name TEXT); INSERT INTO boards VALUES ('launch')")
    db.close()
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('copies the database into a single readable file', async () => {
    const dest = path.join(tmp, 'backup.db')
    await writeDatabaseBackup(source, dest)
    // Checked before opening the copy: opening a WAL-mode database creates its own.
    expect(fs.existsSync(`${dest}-wal`)).toBe(false)
    const copy = new Database(dest, { readonly: true })
    try {
      expect(copy.prepare('SELECT name FROM boards').all()).toEqual([{ name: 'launch' }])
    } finally {
      copy.close()
    }
  })

  posixOnly('writes the copy 0600', async () => {
    const dest = path.join(tmp, 'backup.db')
    await writeDatabaseBackup(source, dest)
    expect(modeOf(dest)).toBe(0o600)
  })

  it('refuses a destination that already exists, leaving it untouched', async () => {
    const dest = path.join(tmp, 'backup.db')
    fs.writeFileSync(dest, 'not mine')
    await expect(writeDatabaseBackup(source, dest)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(fs.readFileSync(dest, 'utf8')).toBe('not mine')
  })

  it('removes the partial file when the backup fails', async () => {
    const dest = path.join(tmp, 'backup.db')
    await expect(writeDatabaseBackup(path.join(tmp, 'missing.db'), dest)).rejects.toThrow()
    expect(fs.existsSync(dest)).toBe(false)
  })
})
