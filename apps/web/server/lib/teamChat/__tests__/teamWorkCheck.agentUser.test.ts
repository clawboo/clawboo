// With agents on their own OS user, the team folder is the agent user's: the
// work check's history of it moves under the work folder, and its git runs as
// the agent user through the host. With the setting off it stays in the data
// folder.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveAgentHost } from '../../agentUser/state'
import { installAgentWorktreeIo } from '../../agentUser/worktreeIo'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import { dropTeamFolderBase, teamFolderHistoryDir } from '../teamWorkCheck'

const posix = process.platform !== 'win32'

describe.runIf(posix)('team work check history under agent isolation', { timeout: 120_000 }, () => {
  let dir: string
  let h: InProcessHost | null = null

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-history-')))
    vi.stubEnv('HOME', dir)
    vi.stubEnv('CLAWBOO_HOME', path.join(dir, 'data'))
    vi.stubEnv('CLAWBOO_WORK_DIR', path.join(dir, 'work'))
    fs.mkdirSync(path.join(dir, 'work', 'teams', 'T'), { recursive: true })
  })

  afterEach(() => {
    setActiveAgentHost(null)
    h?.client.close()
    h = null
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stays in the data folder with the setting off', () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    expect(teamFolderHistoryDir('T')).toBe(path.join(dir, 'data', 'team-folder-history', 'T.git'))
  })

  it('lives under the work folder and is touched only through the host with the setting on', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    installAgentWorktreeIo()
    const gitDir = teamFolderHistoryDir('T')
    expect(gitDir).toBe(path.join(fs.realpathSync(path.join(dir, 'work')), 'team-history', 'T.git'))

    // A history with a task's starting point, made the way the check makes one.
    fs.mkdirSync(gitDir, { recursive: true })
    execFileSync('git', ['init', '--bare', '-q', gitDir])
    const folder = path.join(dir, 'work', 'teams', 'T')
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a\n')
    const g = (...args: string[]): string =>
      execFileSync('git', ['--git-dir', gitDir, '--work-tree', folder, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@x',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@x',
        },
      }).trim()
    g('add', '-A')
    g('commit', '-q', '-m', 'start')
    const taskId = '11111111-1111-4111-8111-111111111111'
    g('update-ref', `refs/clawboo/base/${taskId}`, 'HEAD')

    const spawned: string[][] = []
    const ops: string[] = []
    const origSpawn = h.client.spawn.bind(h.client)
    vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
      spawned.push([o.command, ...o.args])
      return origSpawn(o)
    })
    const origReq = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation(((req: { op: string }, o?: never) => {
      ops.push(req.op)
      return origReq(req as never, o)
    }) as never)

    await dropTeamFolderBase('T', taskId)
    expect(ops).toContain('fs.stat')
    expect(
      spawned.some((a) => a[0] === 'git' && a.includes('update-ref') && a.includes(gitDir)),
    ).toBe(true)
    expect(g('for-each-ref', 'refs/clawboo/base/')).toBe('')
  })
})
