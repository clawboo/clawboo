// The team-chat working folder: which runtimes get one, where it lands, and that
// it can never be the clawboo home, its secrets/ dir, or anywhere outside the
// workspaces root.

import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureTeamWorkdir,
  taskRunWorkdirFor,
  teamWorkdirFor,
  teamWorkdirPath,
} from '../teamWorkdir'

const isWindows = process.platform === 'win32'

describe('team-chat working folder', () => {
  let home: string
  let prev: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-workdir-test-'))
    prev = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home
  })
  afterEach(async () => {
    if (prev === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prev
    await rm(home, { recursive: true, force: true })
  })

  it('is <clawboo home>/workspaces/<teamId>', () => {
    expect(teamWorkdirPath('team-1')).toBe(path.join(home, 'workspaces', 'team-1'))
  })

  it('is one folder per team, shared by every coding runtime on it', () => {
    const cc = teamWorkdirFor('claude-code', 'team-1')
    expect(cc).toBe(path.join(home, 'workspaces', 'team-1'))
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
    expect(taskRunWorkdirFor('claude-code', null)).toBe(path.join(home, 'workspaces', '_no-team'))
    expect(taskRunWorkdirFor('hermes', '')).toBe(path.join(home, 'workspaces', '_no-team'))
    expect(taskRunWorkdirFor('clawboo-native', 'team-1')).toBe(teamWorkdirFor('codex', 'team-1'))
    expect(taskRunWorkdirFor('openclaw', null)).toBeNull()
  })

  it('a hostile team id stays one segment under workspaces/, never the home or secrets/', () => {
    const root = path.join(home, 'workspaces')
    for (const hostile of ['..', '../secrets', '../../etc', '/etc/passwd', '..\\win', '.']) {
      const dir = teamWorkdirPath(hostile)
      expect(path.dirname(dir)).toBe(root)
      expect(dir).not.toBe(home)
      expect(dir.startsWith(path.join(home, 'secrets'))).toBe(false)
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
