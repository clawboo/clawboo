// The database file carries the per-install HMAC secret that MCP attach scopes
// are signed with, and it sits in a directory beside saved browser frames and the
// per-agent browser profiles (live logged-in sessions). Created under a normal
// umask all of that lands 0644/0755, which on a shared or multi-account host is a
// straightforward other-user read.
//
// These assertions are about the OTHER-user bits specifically. They deliberately
// do not claim the secret is unreachable to a process running as the same user —
// it is not, and `mcpAttachSecret.ts` used to say otherwise.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openDb } from '../db'

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-perm-'))
  made.push(dir)
  return path.join(dir, 'nested', 'clawboo.db')
}

const mode = (p: string): number => fs.statSync(p).mode & 0o777

describe.skipIf(process.platform === 'win32')('database file permissions', () => {
  it('opens the database unreadable by other users', () => {
    const dbPath = freshDbPath()
    openDb(dbPath)
    expect(mode(dbPath)).toBe(0o600)
  })

  it('tightens the WAL sidecars too', () => {
    // These hold recently written pages, so leaving them 0644 leaks exactly what
    // the database does.
    //
    // The first version of this test guarded each assertion behind existsSync and
    // therefore asserted NOTHING: `journal_mode = WAL` does not create the
    // sidecars, so at chmod time neither file was there, and the test passed just
    // as happily with the whole fix deleted. That vacuous pass is also what
    // surfaced the real bug — openDb was tightening files that did not exist yet.
    // Requiring their existence is the point of the assertion, not an aside.
    const dbPath = freshDbPath()
    openDb(dbPath)
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      expect(fs.existsSync(sidecar)).toBe(true)
      expect(mode(sidecar)).toBe(0o600)
    }
  })

  it('tightens the containing directory, where the browser profiles live', () => {
    const dbPath = freshDbPath()
    openDb(dbPath)
    expect(mode(path.dirname(dbPath))).toBe(0o700)
  })

  it('repairs a directory that already exists world-readable', () => {
    // The case that matters for anyone already running clawboo: the fix has to
    // reach installs whose directory was created before it shipped, not only
    // fresh ones.
    const dbPath = freshDbPath()
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o755 })
    expect(mode(path.dirname(dbPath))).toBe(0o755)
    openDb(dbPath)
    expect(mode(path.dirname(dbPath))).toBe(0o700)
  })

  it('still opens an in-memory database, which has no path to chmod', () => {
    expect(() => openDb(':memory:')).not.toThrow()
  })
})
