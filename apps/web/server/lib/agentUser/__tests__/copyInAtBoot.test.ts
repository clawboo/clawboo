// Where the boot looks for team folders to copy into agent space. A custom
// work folder the last boot without agent isolation used is not in the
// environment any more once CLAWBOO_WORK_DIR is unset or pointed at agent
// space; the recorded `work-dir` setting still names it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ClawbooDb } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CopyInItem } from '../copyIn'

const recorded = vi.hoisted(() => ({ workDir: null as string | null }))
// This install's teams, by folder name.
const own = vi.hoisted(() => ({ teams: new Set<string>(['team-custom']) }))

vi.mock('@clawboo/db', async (orig) => ({
  ...(await orig<typeof import('@clawboo/db')>()),
  getSetting: (_db: unknown, key: string) => (key === 'work-dir' ? recorded.workDir : null),
}))

vi.mock('../../workDirMigration', async (orig) => ({
  ...(await orig<typeof import('../../workDirMigration')>()),
  ownTeamFolderNames: () => own.teams,
}))

// The plan is what is under test; the copy itself is copyIn.test.ts's.
vi.mock('../copyIn', async (orig) => ({
  ...(await orig<typeof import('../copyIn')>()),
  copyIntoAgentSpace: async (items: CopyInItem[]) => ({
    copied: items.map((i) => i.from),
    present: [],
    skipped: [],
    failed: [],
  }),
}))

import { copyAgentStateIn } from '../copyInAtBoot'

const posix = process.platform !== 'win32'
const db = {} as ClawbooDb

describe.runIf(posix)('the team folders the boot copies into agent space', () => {
  let dir: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-copy-boot-')))
    env = {
      HOME: path.join(dir, 'home'),
      CLAWBOO_HOME: path.join(dir, 'data'),
      CLAWBOO_WORK_DIR: path.join(dir, 'agent', 'work'),
    }
    fs.mkdirSync(path.join(dir, 'data', 'workspaces', 'team-old'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'custom-work', 'teams', 'team-custom'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'agent', 'work', 'teams'), { recursive: true })
  })

  afterEach(() => {
    recorded.workDir = null
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('include the work folder the last boot recorded', async () => {
    recorded.workDir = path.join(dir, 'custom-work')
    const report = await copyAgentStateIn(env, db)
    expect(report.copied).toEqual([
      path.join(dir, 'custom-work', 'teams', 'team-custom'),
      path.join(dir, 'data', 'workspaces', 'team-old'),
    ])
  })

  it("leave another install's teams in a shared work folder", async () => {
    recorded.workDir = path.join(dir, 'custom-work')
    fs.mkdirSync(path.join(dir, 'custom-work', 'teams', 'team-of-another-install'))
    const report = await copyAgentStateIn(env, db)
    expect(report.copied).toEqual([
      path.join(dir, 'custom-work', 'teams', 'team-custom'),
      // The data folder is this install's own: every team folder in it.
      path.join(dir, 'data', 'workspaces', 'team-old'),
    ])
  })

  it('never include the work folder in use', async () => {
    recorded.workDir = path.join(dir, 'agent', 'work')
    fs.mkdirSync(path.join(dir, 'agent', 'work', 'teams', 'team-here'))
    const report = await copyAgentStateIn(env, db)
    expect(report.copied).toEqual([path.join(dir, 'data', 'workspaces', 'team-old')])
  })
})
