// Where the verify gate agrees to run: a task or review checkout or a team
// folder under the work folder's worktrees/, reviews/ and teams/, or anything
// under the data folder, where older versions made them, or a place the work
// folder move kept one at. Anything else is a broken record and is refused
// before a command runs.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setWorkDirJournal } from '../../workDirJournal'
import { runDeterministicGate } from '../deterministicGate'

// Exits 0 on every platform the server tests run on.
const PASSING = 'git --version'
/** Passes only when run in a folder holding `marker.txt`. */
const IN_CHECKOUT = `node -e "process.exit(require('fs').existsSync('marker.txt') ? 0 : 1)"`

let base: string
let dataDir: string
let prevHome: string | undefined
let prevWorkDir: string | undefined

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'clawboo-gate-wd-'))
  dataDir = path.join(base, 'data')
  await mkdir(dataDir, { recursive: true })
  prevHome = process.env['CLAWBOO_HOME']
  prevWorkDir = process.env['CLAWBOO_WORK_DIR']
  process.env['CLAWBOO_HOME'] = dataDir
  delete process.env['CLAWBOO_WORK_DIR']
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  if (prevWorkDir === undefined) delete process.env['CLAWBOO_WORK_DIR']
  else process.env['CLAWBOO_WORK_DIR'] = prevWorkDir
  setWorkDirJournal({ version: 1, items: [] })
  await rm(base, { recursive: true, force: true })
})

async function checkout(...segments: string[]): Promise<string> {
  const dir = path.join(...segments)
  await mkdir(dir, { recursive: true })
  return dir
}

async function gateIn(worktreePath: string) {
  return runDeterministicGate({ worktreePath, verifyCommand: PASSING })
}

describe('the verify gate accepts both layouts', () => {
  it('runs in a task checkout under the data folder', async () => {
    const wt = await checkout(dataDir, 'worktrees', 'abc', 't1')
    expect(await gateIn(wt)).toMatchObject({ passed: true, exitCode: 0 })
    // The command runs in the checkout itself, not just somewhere it can pass.
    await writeFile(path.join(wt, 'marker.txt'), 'here')
    const det = await runDeterministicGate({ worktreePath: wt, verifyCommand: IN_CHECKOUT })
    expect(det.passed).toBe(true)
  })

  it('runs in a task checkout under the default work folder beside CLAWBOO_HOME', async () => {
    const wt = await checkout(`${dataDir}-work`, 'worktrees', 'abc', 't1')
    expect(await gateIn(wt)).toMatchObject({ passed: true, exitCode: 0 })
  })

  it('runs in task and review checkouts under CLAWBOO_WORK_DIR', async () => {
    const work = path.join(base, 'work')
    process.env['CLAWBOO_WORK_DIR'] = work
    const task = await checkout(work, 'worktrees', 'abc', 't1')
    const review = await checkout(work, 'reviews', 'abc', '0123456789ab')
    expect(await gateIn(task)).toMatchObject({ passed: true })
    expect(await gateIn(review)).toMatchObject({ passed: true })
  })

  it('runs in a team folder under the work folder', async () => {
    process.env['CLAWBOO_WORK_DIR'] = path.join(base, 'work')
    const team = await checkout(base, 'work', 'teams', 'team-1')
    expect(await gateIn(team)).toMatchObject({ passed: true })
  })

  it('runs in a checkout the work folder move kept in a previous work folder', async () => {
    process.env['CLAWBOO_WORK_DIR'] = path.join(base, 'work')
    const kept = await checkout(base, 'old-work', 'worktrees', 'abc', 't1')
    await expect(gateIn(kept)).rejects.toThrow(/outside/)
    setWorkDirJournal({
      version: 1,
      items: [
        {
          kind: 'worktree',
          taskId: 't1',
          workspaceId: 'w1',
          repoPath: base,
          from: kept,
          to: path.join(base, 'work', 'worktrees', 'abc', 't1'),
          state: 'left',
        },
      ],
    })
    expect(await gateIn(kept)).toMatchObject({ passed: true })
    // Only that folder's root, not the rest of the old work folder.
    const other = await checkout(base, 'old-work', 'worktrees', 'zzz', 't2')
    await expect(gateIn(other)).rejects.toThrow(/outside/)
  })

  it('runs in a checkout recorded by the real path of a linked work folder', async () => {
    const target = await checkout(base, 'real-work')
    const linked = path.join(base, 'linked-work')
    await symlink(target, linked, 'junction')
    process.env['CLAWBOO_WORK_DIR'] = linked
    const wt = await checkout(await realpath(target), 'worktrees', 'abc', 't1')
    expect(await gateIn(wt)).toMatchObject({ passed: true })
    expect(await gateIn(path.join(linked, 'worktrees', 'abc', 't1'))).toMatchObject({
      passed: true,
    })
  })
})

describe('the verify gate still refuses anything else', () => {
  it.each([
    ['the work folder itself', ['work']],
    ['its teams folder itself', ['work', 'teams']],
    ['a file folder beside the roots', ['work', 'notes', 'n1']],
    ['its worktrees folder itself', ['work', 'worktrees']],
    ['a sibling sharing its spelling', ['work-old', 'worktrees', 'abc', 't1']],
    ['a folder outside both', ['elsewhere', 'worktrees', 'abc', 't1']],
  ])('%s', async (_name, segments) => {
    process.env['CLAWBOO_WORK_DIR'] = path.join(base, 'work')
    const dir = await checkout(base, ...segments)
    await expect(gateIn(dir)).rejects.toThrow(/outside/)
  })

  it('a checkout under the data folder that is a link to a folder outside both', async () => {
    // A repository elsewhere, reached through a link where a checkout belongs.
    const outside = await checkout(base, 'elsewhere', 'repo')
    await writeFile(path.join(outside, 'VERIFICATION.md'), 'untouched\n')
    await mkdir(path.join(dataDir, 'worktrees', 'abc'), { recursive: true })
    const link = path.join(dataDir, 'worktrees', 'abc', 't1')
    await symlink(outside, link, 'junction')

    await expect(gateIn(link)).rejects.toThrow(/outside/)
    expect(await readFile(path.join(outside, 'VERIFICATION.md'), 'utf8')).toBe('untouched\n')
  })
})
