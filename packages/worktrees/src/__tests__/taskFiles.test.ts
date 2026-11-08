// The task files at the top of a checkout are the agent's to write, so any of
// them can be a link, or a hard link, to a file the server can open (its
// database, its vault key). The handoff reads and writes them without following
// either: a link or a hard link reads as no file, and a write replaces the name
// instead of writing through it.

import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readHandoff, reconstructState, writeHandoff } from '../handoff'
import { SOR_FILES } from '../scaffold'
import { appendTaskFile, readTaskFile, replaceTaskFile, UnsafeTaskFileError } from '../taskFiles'

// A file link on Windows needs Developer Mode or an administrator. The link
// cases run wherever one can be made, and are skipped only where making one is
// refused (EPERM); the hard-link cases run everywhere.
let canSymlink = true
const NO_LINKS = 'this user may not make file links (EPERM)'

beforeAll(async () => {
  const probe = await mkdtemp(path.join(os.tmpdir(), 'clawboo-taskfiles-probe-'))
  try {
    await writeFile(path.join(probe, 'target'), '')
    await symlink(path.join(probe, 'target'), path.join(probe, 'link'), 'file')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
    canSymlink = false
  } finally {
    await rm(probe, { recursive: true, force: true })
  }
})

const handoff = {
  handoffFrom: 'A',
  runtime: 'codex',
  completedSubtasks: ['did a'],
  brokenOrUnverified: [],
  nextBestStep: 'do b',
  commands: { init: './init.sh', verify: 'make test', start: '' },
  evidence: {},
  warnings: [],
}
// A valid handoff, so a reader that followed a link to it would return it.
const SECRET = JSON.stringify({ ...handoff, timestamp: '2026-11-08T00:00:00.000Z' })

describe('task files are never read or written through a link', () => {
  let dir: string
  let secretDir: string
  let secret: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-taskfiles-'))
    secretDir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-taskfiles-secret-'))
    secret = path.join(secretDir, 'master.key')
    await writeFile(secret, SECRET)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(secretDir, { recursive: true, force: true })
  })

  it('readHandoff does not follow a link at AGENT_HANDOFF.json', async (ctx) => {
    ctx.skip(!canSymlink, NO_LINKS)
    await symlink(secret, path.join(dir, SOR_FILES.handoff))
    expect(await readHandoff(dir)).toBeNull()
  })

  it('readHandoff refuses a hard link to another file', async () => {
    await link(secret, path.join(dir, SOR_FILES.handoff))
    expect(await readHandoff(dir)).toBeNull()
    await expect(readTaskFile(dir, SOR_FILES.handoff)).rejects.toBeInstanceOf(UnsafeTaskFileError)
  })

  it('readTaskFile refuses a link with UnsafeTaskFileError', async (ctx) => {
    ctx.skip(!canSymlink, NO_LINKS)
    await symlink(secret, path.join(dir, SOR_FILES.handoff))
    await expect(readTaskFile(dir, SOR_FILES.handoff)).rejects.toBeInstanceOf(UnsafeTaskFileError)
  })

  it('writeHandoff replaces a link at the name, never its target', async (ctx) => {
    ctx.skip(!canSymlink, NO_LINKS)
    await symlink(secret, path.join(dir, SOR_FILES.handoff))
    await writeHandoff(dir, { ...handoff, nextBestStep: 'written' })
    expect(await readFile(secret, 'utf8')).toBe(SECRET)
    expect((await readHandoff(dir))?.nextBestStep).toBe('written')
  })

  it('writeHandoff replaces a hard link at the name, never the file it shares', async () => {
    await link(secret, path.join(dir, SOR_FILES.handoff))
    await writeHandoff(dir, { ...handoff, nextBestStep: 'written' })
    expect(await readFile(secret, 'utf8')).toBe(SECRET)
    expect((await readHandoff(dir))?.nextBestStep).toBe('written')
  })

  it('reconstructState reads no init.sh or progress file through a link', async (ctx) => {
    ctx.skip(!canSymlink, NO_LINKS)
    const init = path.join(secretDir, 'init.sh')
    await writeFile(init, "VERIFY_CMD='cat ~/.clawboo/secrets/master.key'\n")
    const progress = path.join(secretDir, 'progress.md')
    await writeFile(progress, '## Done\n- leaked line\n')
    await symlink(init, path.join(dir, SOR_FILES.init))
    await symlink(progress, path.join(dir, SOR_FILES.progress))
    const state = await reconstructState(dir)
    expect(state.commands.verify).toBe('')
    expect(state.done).toEqual([])
  })

  it('appendTaskFile refuses a link, and one that points nowhere yet', async (ctx) => {
    ctx.skip(!canSymlink, NO_LINKS)
    await symlink(secret, path.join(dir, 'VERIFICATION.md'))
    await expect(appendTaskFile(dir, 'VERIFICATION.md', 'x')).rejects.toBeInstanceOf(
      UnsafeTaskFileError,
    )
    await symlink(path.join(secretDir, 'new.txt'), path.join(dir, 'other.md'), 'file')
    await expect(appendTaskFile(dir, 'other.md', 'x')).rejects.toBeInstanceOf(UnsafeTaskFileError)
    expect(await readFile(secret, 'utf8')).toBe(SECRET)
    await expect(readFile(path.join(secretDir, 'new.txt'))).rejects.toThrow()
  })

  it('appendTaskFile refuses a hard link, and appends to a plain file', async () => {
    await link(secret, path.join(dir, 'VERIFICATION.md'))
    await expect(appendTaskFile(dir, 'VERIFICATION.md', 'x')).rejects.toBeInstanceOf(
      UnsafeTaskFileError,
    )
    expect(await readFile(secret, 'utf8')).toBe(SECRET)
    await appendTaskFile(dir, 'plain.md', 'one\n')
    await appendTaskFile(dir, 'plain.md', 'two\n')
    expect(await readFile(path.join(dir, 'plain.md'), 'utf8')).toBe('one\ntwo\n')
  })

  it('refuses a name that is not one path segment', async () => {
    await expect(readTaskFile(dir, '../x')).rejects.toThrow(/not a file name/)
    await expect(replaceTaskFile(dir, 'a/b', 'x')).rejects.toThrow(/not a file name/)
  })
})
