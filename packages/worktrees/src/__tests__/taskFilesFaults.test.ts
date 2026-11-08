// The task file helpers where the file system works against them: a platform
// with no O_NOFOLLOW whose exclusive create follows a link, as on Windows; a
// name swapped between the check and the open; and a write that fails partway.
// The open and the handle it returns are wrapped so a test can act at those
// moments; everything else is the real file system.

import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appendTaskFile, readTaskFile, replaceTaskFile, UnsafeTaskFileError } from '../taskFiles'

const hooks = vi.hoisted(() => ({
  /** Runs once, just before the next open of a path ending in `name`. A missing
   *  file is made under a temp name (ending `.tmp`) before it gets its own. */
  beforeOpen: null as null | { name: string; fn: () => Promise<void> },
  /** Makes the next handle's `writeFile` or `close` fail. */
  fail: null as null | 'writeFile' | 'close',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const armed = hooks.beforeOpen
    if (armed && String(args[0]).endsWith(armed.name)) {
      hooks.beforeOpen = null
      await armed.fn()
    }
    // As on Windows: an exclusive create follows a link at the name, even one
    // that points nowhere, and makes the file it points to.
    const want = typeof args[1] === 'number' ? args[1] : 0
    const { O_CREAT, O_EXCL } = actual.constants
    if ((want & O_CREAT) !== 0 && (want & O_EXCL) !== 0) {
      const at = String(args[0])
      const st = await actual.lstat(at).catch(() => null)
      if (st?.isSymbolicLink()) {
        args[0] = path.resolve(path.dirname(at), await actual.readlink(at))
      }
    }
    const handle = await actual.open(...args)
    const fail = hooks.fail
    hooks.fail = null
    if (fail === 'writeFile') {
      handle.writeFile = async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }
    } else if (fail === 'close') {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        throw Object.assign(new Error('i/o error'), { code: 'EIO' })
      }
    }
    return handle
  }) as typeof actual.open
  const mocked = { ...actual, open }
  return { ...mocked, default: mocked }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const flags: Partial<Record<keyof typeof actual.constants, number>> = { ...actual.constants }
  delete flags.O_NOFOLLOW
  return { ...actual, constants: flags, default: { ...actual, constants: flags } }
})

const SECRET = 'vault-key-canary'

let dir: string
let secretDir: string
let secret: string

beforeEach(async () => {
  hooks.beforeOpen = null
  hooks.fail = null
  dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-taskfaults-'))
  secretDir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-taskfaults-secret-'))
  secret = path.join(secretDir, 'master.key')
  await writeFile(secret, SECRET)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(secretDir, { recursive: true, force: true })
})

/** Whether this user may make a file link (Windows needs extra rights). */
async function canSymlink(): Promise<boolean> {
  const at = path.join(dir, 'probe')
  try {
    await symlink(secret, at, 'file')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
    throw err
  }
  await unlink(at)
  return true
}

describe('task files when the open has no O_NOFOLLOW', () => {
  it('refuses a link at the name before opening it', async (ctx) => {
    ctx.skip(!(await canSymlink()), 'this user may not make file links (EPERM)')
    await symlink(secret, path.join(dir, 'AGENT_HANDOFF.json'), 'file')
    await expect(readTaskFile(dir, 'AGENT_HANDOFF.json')).rejects.toBeInstanceOf(
      UnsafeTaskFileError,
    )
    await expect(appendTaskFile(dir, 'AGENT_HANDOFF.json', 'x')).rejects.toBeInstanceOf(
      UnsafeTaskFileError,
    )
    expect(await readFile(secret, 'utf8')).toBe(SECRET)
  })

  it('refuses a file swapped for a link between the check and the open', async (ctx) => {
    ctx.skip(!(await canSymlink()), 'this user may not make file links (EPERM)')
    const name = 'VERIFICATION.md'
    const swap = async (): Promise<void> => {
      await rm(path.join(dir, name), { force: true })
      await symlink(secret, path.join(dir, name), 'file')
    }
    await writeFile(path.join(dir, name), 'plain\n')
    hooks.beforeOpen = { name, fn: swap }
    await expect(readTaskFile(dir, name)).rejects.toBeInstanceOf(UnsafeTaskFileError)

    await rm(path.join(dir, name), { force: true })
    await writeFile(path.join(dir, name), 'plain\n')
    hooks.beforeOpen = { name, fn: swap }
    await expect(appendTaskFile(dir, name, 'x')).rejects.toBeInstanceOf(UnsafeTaskFileError)
    expect(await readFile(secret, 'utf8')).toBe(SECRET)
  })

  it('creating a missing file fails on a link put at the name meanwhile', async (ctx) => {
    ctx.skip(!(await canSymlink()), 'this user may not make file links (EPERM)')
    const nowhere = path.join(secretDir, 'new.txt')
    hooks.beforeOpen = {
      name: '.tmp',
      fn: () => symlink(nowhere, path.join(dir, 'other.md'), 'file'),
    }
    await expect(appendTaskFile(dir, 'other.md', 'x')).rejects.toBeInstanceOf(UnsafeTaskFileError)
    await expect(readFile(nowhere)).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['other.md'])
  })

  it('appends to a plain file made at the name since the check', async () => {
    hooks.beforeOpen = {
      name: '.tmp',
      fn: () => writeFile(path.join(dir, 'notes.md'), 'one\n'),
    }
    await appendTaskFile(dir, 'notes.md', 'two\n')
    expect(await readFile(path.join(dir, 'notes.md'), 'utf8')).toBe('one\ntwo\n')
  })
})

describe('replaceTaskFile', () => {
  it.each(['writeFile', 'close'] as const)(
    'leaves no temp file and the old file as it was when %s fails',
    async (step) => {
      await writeFile(path.join(dir, 'AGENT_HANDOFF.json'), 'old\n')
      hooks.fail = step
      await expect(replaceTaskFile(dir, 'AGENT_HANDOFF.json', 'new\n')).rejects.toThrow()
      expect(await readdir(dir)).toEqual(['AGENT_HANDOFF.json'])
      expect(await readFile(path.join(dir, 'AGENT_HANDOFF.json'), 'utf8')).toBe('old\n')
    },
  )
})
