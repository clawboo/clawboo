// The team-chat working folder: which runtimes get one, where it lands (the work
// folder's teams/, outside the clawboo home), and that it can never be the
// clawboo home, its secrets/ dir, or anywhere outside the team folders' root.

import { realpathSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setWorkLayout } from '../../workDir'
import { setWorkDirJournal } from '../../workDirJournal'
import {
  ensureTeamWorkdir,
  legacyTeamFolderPath,
  taskRunWorkdirFor,
  teamWorkdirFor,
  teamWorkdirPath,
} from '../teamWorkdir'

const isWindows = process.platform === 'win32'

describe('team-chat working folder', () => {
  let home: string
  let prev: string | undefined

  // With CLAWBOO_HOME set and no CLAWBOO_WORK_DIR, the work folder is its
  // `-work` sibling, used by its real path (macOS's temp folder is a link).
  let teams: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-workdir-test-'))
    teams = path.join(realpathSync.native(os.tmpdir()), `${path.basename(home)}-work`, 'teams')
    prev = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home
  })
  afterEach(async () => {
    setWorkLayout('work')
    setWorkDirJournal({ version: 1, items: [] })
    if (prev === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prev
    await rm(home, { recursive: true, force: true })
    await rm(`${home}-work`, { recursive: true, force: true })
  })

  it('is <work folder>/teams/<teamId>, outside the clawboo home', () => {
    expect(teamWorkdirPath('team-1')).toBe(path.join(teams, 'team-1'))
    expect(teamWorkdirPath('team-1').startsWith(home + path.sep)).toBe(false)
  })

  it('is <clawboo home>/workspaces/<teamId> in the old layout', () => {
    setWorkLayout('data')
    expect(teamWorkdirPath('team-1')).toBe(path.join(home, 'workspaces', 'team-1'))
  })

  it('stays at the old place while the work folder move keeps it there', () => {
    const old = path.join(home, 'workspaces', 'team-1')
    for (const state of ['left', 'conflict', 'moving'] as const) {
      setWorkDirJournal({
        version: 1,
        items: [{ kind: 'team', name: 'team-1', from: old, to: path.join(teams, 'team-1'), state }],
      })
      expect(teamWorkdirPath('team-1')).toBe(old)
      expect(teamWorkdirPath('team-2')).toBe(path.join(teams, 'team-2'))
    }
    setWorkDirJournal({
      version: 1,
      items: [
        { kind: 'team', name: 'team-1', from: old, to: path.join(teams, 'team-1'), state: 'moved' },
      ],
    })
    expect(teamWorkdirPath('team-1')).toBe(path.join(teams, 'team-1'))
  })

  it('is one folder per team, shared by every coding runtime on it', () => {
    const cc = teamWorkdirFor('claude-code', 'team-1')
    expect(cc).toBe(path.join(teams, 'team-1'))
    expect(teamWorkdirFor('codex', 'team-1')).toBe(cc)
    expect(teamWorkdirFor('hermes', 'team-1')).toBe(cc)
    expect(teamWorkdirFor('clawboo-native', 'team-1')).toBe(cc)
    expect(teamWorkdirFor('codex', 'team-2')).not.toBe(cc)
  })

  it('is null for OpenClaw, the mock harness, an unknown runtime, or no team', () => {
    expect(teamWorkdirFor('openclaw', 'team-1')).toBeNull()
    expect(teamWorkdirFor('something-else', 'team-1')).toBeNull()
    expect(teamWorkdirFor('clawboo-mock', 'team-1')).toBeNull()
    expect(teamWorkdirFor(null, 'team-1')).toBeNull()
    expect(teamWorkdirFor('codex', null)).toBeNull()
    expect(teamWorkdirFor('codex', '')).toBeNull()
  })

  it('a task run with no worktree uses its team folder, or _no-team without a team', () => {
    expect(taskRunWorkdirFor('codex', 'team-1')).toBe(teamWorkdirFor('codex', 'team-1'))
    expect(taskRunWorkdirFor('claude-code', null)).toBe(path.join(teams, '_no-team'))
    expect(taskRunWorkdirFor('hermes', '')).toBe(path.join(teams, '_no-team'))
    expect(taskRunWorkdirFor('clawboo-native', 'team-1')).toBe(teamWorkdirFor('codex', 'team-1'))
    expect(taskRunWorkdirFor('openclaw', null)).toBeNull()
  })

  it('a hostile team id stays one segment under teams/, never the home or secrets/', () => {
    const root = teams
    for (const hostile of ['..', '../secrets', '../../etc', '/etc/passwd', '..\\win', '.']) {
      const dir = teamWorkdirPath(hostile)
      expect(path.dirname(dir)).toBe(root)
      expect(dir).not.toBe(home)
      expect(dir.startsWith(path.join(home, 'secrets'))).toBe(false)
    }
  })

  it('the old place of a team folder is one segment under <clawboo home>/workspaces', () => {
    const root = path.join(home, 'workspaces')
    expect(legacyTeamFolderPath('team-1')).toBe(path.join(root, 'team-1'))
    for (const hostile of ['..', '../secrets', '/etc/passwd', '..\\win', '.']) {
      expect(path.dirname(legacyTeamFolderPath(hostile))).toBe(root)
    }
  })

  it.skipIf(isWindows)(
    'ensureTeamWorkdir creates the folder and its parent owner-only',
    async () => {
      const dir = teamWorkdirPath('team-1')
      await ensureTeamWorkdir(dir)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(path.dirname(dir))).mode & 0o777).toBe(0o700)
      // Idempotent on the next run.
      await expect(ensureTeamWorkdir(dir)).resolves.toBeUndefined()
    },
  )
})
