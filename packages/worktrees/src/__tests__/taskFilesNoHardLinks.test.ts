// Task files on a file system that cannot make hard links (FAT, exFAT, some
// network shares). Where the platform has O_NOFOLLOW, a missing file is created
// without one, and a link at the name is still refused.

import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appendTaskFile, UnsafeTaskFileError } from '../taskFiles'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const link = (async () => {
    throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })
  }) as typeof actual.link
  const mocked = { ...actual, link }
  return { ...mocked, default: mocked }
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-nohardlinks-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('task files without hard links', () => {
  it('creates a missing file and appends to it', async () => {
    await appendTaskFile(dir, 'VERIFICATION.md', 'evidence\n')
    await appendTaskFile(dir, 'VERIFICATION.md', 'more\n')
    expect(await readFile(path.join(dir, 'VERIFICATION.md'), 'utf8')).toBe('evidence\nmore\n')
  })

  it('still refuses a link that points nowhere at the name', async () => {
    const nowhere = path.join(dir, 'outside', 'new.txt')
    await symlink(nowhere, path.join(dir, 'VERIFICATION.md'))
    await expect(appendTaskFile(dir, 'VERIFICATION.md', 'x')).rejects.toBeInstanceOf(
      UnsafeTaskFileError,
    )
    await expect(readFile(nowhere)).rejects.toThrow()
  })
})
