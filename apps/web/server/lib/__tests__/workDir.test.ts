// The work folder at boot: the server refuses one that is the data folder, sits
// inside it or contains it (on real paths, so a link cannot hide it), creates it
// owner-only with a README, and falls back to the old layout only when it was
// not set and cannot be made. And the marker beside each checkout this install
// makes there, which never writes through a link.

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ownerMarkerPath,
  prepareWorkDir,
  readOwnerMarker,
  setWorkLayout,
  workDirInUse,
  workDirRefusal,
  workLayout,
  writeOwnerMarker,
} from '../workDir'

const isWindows = process.platform === 'win32'

let base: string
const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ HOME: base, ...vars })

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'clawboo-workdir-')))
})
afterEach(async () => {
  setWorkLayout('work')
  await rm(base, { recursive: true, force: true })
})

describe('workDirRefusal', () => {
  const data = (): string => path.join(base, 'data')

  it('accepts the defaults and a folder beside the data folder', () => {
    expect(workDirRefusal(env({}))).toBeNull()
    expect(workDirRefusal(env({ CLAWBOO_HOME: data() }))).toBeNull()
    expect(
      workDirRefusal(env({ CLAWBOO_HOME: data(), CLAWBOO_WORK_DIR: `${data()}-old` })),
    ).toBeNull()
  })

  it('refuses the data folder itself, a folder inside it, and one that contains it', () => {
    for (const work of [data(), path.join(data(), 'work'), base]) {
      const why = workDirRefusal(env({ CLAWBOO_HOME: data(), CLAWBOO_WORK_DIR: work }))
      expect(why).toMatch(/CLAWBOO_WORK_DIR|data folder/)
      expect(why).toContain(data())
    }
  })

  it.skipIf(isWindows)(
    'compares real paths, so a link into the data folder is refused',
    async () => {
      await mkdir(path.join(data(), 'inner'), { recursive: true })
      const linked = path.join(base, 'looks-outside')
      await symlink(path.join(data(), 'inner'), linked)
      expect(workDirRefusal(env({ CLAWBOO_HOME: data(), CLAWBOO_WORK_DIR: linked }))).toMatch(
        /must be outside/,
      )
    },
  )
})

describe('prepareWorkDir', () => {
  it.skipIf(isWindows)('creates the work folder owner-only, with a README', async () => {
    const r = prepareWorkDir(env({ CLAWBOO_HOME: path.join(base, 'data') }))
    expect(r).toEqual({ ok: true, dir: path.join(base, 'data-work') })
    expect((await stat(path.join(base, 'data-work'))).mode & 0o777).toBe(0o700)
    expect(await readFile(path.join(base, 'data-work', 'README.txt'), 'utf8')).toMatch(
      /Clawboo's agents/,
    )
    expect(workLayout()).toBe('work')
    // Again: nothing changes, the README is not rewritten.
    await writeFile(path.join(base, 'data-work', 'README.txt'), 'mine')
    expect(prepareWorkDir(env({ CLAWBOO_HOME: path.join(base, 'data') })).ok).toBe(true)
    expect(await readFile(path.join(base, 'data-work', 'README.txt'), 'utf8')).toBe('mine')
  })

  it('keeps the old layout when the default cannot be made', async () => {
    await writeFile(path.join(base, 'data-work'), 'a file in the way')
    const r = prepareWorkDir(env({ CLAWBOO_HOME: path.join(base, 'data') }))
    expect(r).toMatchObject({ ok: false, explicit: false })
    expect(workLayout()).toBe('data')
  })

  it('says a CLAWBOO_WORK_DIR that cannot be made is explicit, for the server to refuse', async () => {
    await writeFile(path.join(base, 'blocked'), 'a file in the way')
    const r = prepareWorkDir(env({ CLAWBOO_WORK_DIR: path.join(base, 'blocked', 'work') }))
    expect(r).toMatchObject({ ok: false, explicit: true })
  })

  it.skipIf(isWindows)('uses a linked work folder by its real path', async () => {
    await mkdir(path.join(base, 'real-work'))
    await symlink(path.join(base, 'real-work'), path.join(base, 'linked-work'))
    const vars = env({ CLAWBOO_WORK_DIR: path.join(base, 'linked-work') })
    expect(workDirInUse(vars)).toBe(path.join(base, 'real-work'))
    expect(prepareWorkDir(vars)).toEqual({ ok: true, dir: path.join(base, 'real-work') })
  })
})

describe('the ownership marker', () => {
  it('records and reads back an install id beside the checkout', async () => {
    const root = path.join(base, 'worktrees', 'abc')
    await mkdir(root, { recursive: true })
    await writeOwnerMarker(root, 't1', 'install-a')
    expect(readOwnerMarker(root, 't1')).toBe('install-a')
    expect(readOwnerMarker(root, 't2')).toBeNull()
    expect(path.basename(ownerMarkerPath(root, 't1'))).toBe('.t1.owner')
  })

  it.skipIf(isWindows)('replaces a link at the marker name, never writing its target', async () => {
    const root = path.join(base, 'worktrees', 'abc')
    await mkdir(root, { recursive: true })
    const db = path.join(base, 'clawboo.db')
    await writeFile(db, 'database')
    await symlink(db, ownerMarkerPath(root, 't1'))
    expect(readOwnerMarker(root, 't1')).toBeNull()
    await writeOwnerMarker(root, 't1', 'install-a')
    expect(await readFile(db, 'utf8')).toBe('database')
    expect(readOwnerMarker(root, 't1')).toBe('install-a')
    expect(existsSync(db)).toBe(true)
  })

  it('refuses a task id that is not one path segment', async () => {
    await expect(writeOwnerMarker(base, '../x', 'id')).rejects.toThrow(/unsafe task id/)
  })

  it('puts the marker directly in the resolved root, however the root is spelled', () => {
    const spelled = path.join(base, 'worktrees', 'x', '..', 'abc')
    const marker = ownerMarkerPath(spelled, 't1')
    expect(marker).toBe(path.join(base, 'worktrees', 'abc', '.t1.owner'))
    expect(() => ownerMarkerPath(base, '..')).toThrow(/unsafe task id/)
  })
})
