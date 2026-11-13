// The one-time copy of agent state into agent space (design 4.10), and the
// setup plan.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyIntoAgentSpace, planCopyIn } from '../copyIn'
import { agentUserPlan } from '../plan'
import { setActiveAgentHost } from '../state'
import { startInProcessHost, type InProcessHost } from './inProcessHost'

const posix = process.platform !== 'win32'

describe.runIf(posix)('copying agent state into agent space', () => {
  let dir: string
  let h: InProcessHost

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-copy-')))
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
  })

  afterEach(() => {
    setActiveAgentHost(null)
    h.client.close()
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function layout(): {
    data: string
    agentRt: string
    work: string
    plan: ReturnType<typeof planCopyIn>
  } {
    const data = path.join(dir, 'data')
    const agentRt = path.join(dir, 'agent', 'runtimes')
    const work = path.join(dir, 'agent', 'work')
    fs.mkdirSync(path.join(data, 'runtimes', 'hermes', 'a1', 'memories'), { recursive: true })
    fs.writeFileSync(
      path.join(data, 'runtimes', 'hermes', 'a1', 'memories', 'MEMORY.md'),
      'remember this',
    )
    fs.writeFileSync(path.join(data, 'runtimes', 'hermes', 'a1', 'run.sh'), '#!/bin/sh\n', {
      mode: 0o755,
    })
    // A link an agent planted, pointing at the vault key.
    fs.writeFileSync(path.join(data, 'master.key'), 'KEY')
    fs.symlinkSync(
      path.join(data, 'master.key'),
      path.join(data, 'runtimes', 'hermes', 'a1', 'key.txt'),
    )
    // A hard link to the database under another name.
    fs.writeFileSync(path.join(data, 'clawboo.db'), 'DB')
    fs.linkSync(
      path.join(data, 'clawboo.db'),
      path.join(data, 'runtimes', 'hermes', 'a1', 'notes.db'),
    )
    fs.mkdirSync(path.join(data, 'workspaces', 'team-1'), { recursive: true })
    fs.writeFileSync(path.join(data, 'workspaces', 'team-1', 'plan.md'), '# plan')
    fs.mkdirSync(work, { recursive: true })
    const plan = planCopyIn({
      dataDir: data,
      agentRuntimesRoot: agentRt,
      workDir: work,
      teamRoots: [path.join(data, 'workspaces')],
    })
    return { data, agentRt, work, plan }
  }

  it('copies runtime homes and team folders through the host, never a link or a hard-linked file', async () => {
    const { data, agentRt, work, plan } = layout()
    expect(plan.map((i) => path.relative(dir, i.to))).toEqual([
      'agent/runtimes/hermes/a1',
      'agent/work/teams/team-1',
    ])
    const ops: string[] = []
    const orig = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation(((req: { op: string }) => {
      ops.push(req.op)
      return orig(req as never)
    }) as never)

    const report = await copyIntoAgentSpace(plan)
    expect(report.copied).toHaveLength(2)
    const home = path.join(agentRt, 'hermes', 'a1')
    expect(fs.readFileSync(path.join(home, 'memories', 'MEMORY.md'), 'utf8')).toBe('remember this')
    expect(fs.statSync(path.join(home, 'run.sh')).mode & 0o777).toBe(0o700)
    expect(fs.existsSync(path.join(home, 'key.txt'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'notes.db'))).toBe(false)
    expect(report.skipped.map((s) => path.basename(s.path)).sort()).toEqual(['key.txt', 'notes.db'])
    expect(fs.readFileSync(path.join(work, 'teams', 'team-1', 'plan.md'), 'utf8')).toBe('# plan')
    // Every write went through the host.
    expect(ops).toEqual(expect.arrayContaining(['fs.mkdir', 'fs.write', 'fs.rename']))
    // The originals stay, so turning the setting off is the rollback.
    expect(
      fs.existsSync(path.join(data, 'runtimes', 'hermes', 'a1', 'memories', 'MEMORY.md')),
    ).toBe(true)

    // A second start finds them there and copies nothing.
    const again = await copyIntoAgentSpace(plan)
    expect(again.copied).toEqual([])
    expect(again.present).toHaveLength(2)
  })

  it('copies a file larger than one write in chunks', async () => {
    const { data, agentRt, plan } = layout()
    const big = Buffer.alloc(9 * 1024 * 1024, 7)
    fs.writeFileSync(path.join(data, 'runtimes', 'hermes', 'a1', 'state.db'), big)
    await copyIntoAgentSpace(plan)
    expect(fs.readFileSync(path.join(agentRt, 'hermes', 'a1', 'state.db')).equals(big)).toBe(true)
  })

  it('leaves no finished-looking copy when a copy fails part way', async () => {
    const { agentRt, plan } = layout()
    const orig = h.client.request.bind(h.client)
    let writes = 0
    vi.spyOn(h.client, 'request').mockImplementation(((req: { op: string }) => {
      if (req.op === 'fs.write' && ++writes === 2) return Promise.reject(new Error('disk full'))
      return orig(req as never)
    }) as never)
    const report = await copyIntoAgentSpace(plan.slice(0, 1))
    expect(report.copied).toEqual([])
    expect(report.skipped.some((s) => /disk full/.test(s.reason))).toBe(true)
    expect(fs.existsSync(path.join(agentRt, 'hermes', 'a1'))).toBe(false)
  })
})

describe('the setup plan', () => {
  const base = {
    serverUser: 'alice',
    agentHome: '/var/lib/clawboo-agent',
    nodePath: '/usr/local/bin/node',
    serverHome: '/home/alice',
  }

  it('prints the Linux commands with the names filled in', () => {
    const text = agentUserPlan({
      ...base,
      platform: 'linux',
      agentUser: 'clawboo-agent',
      roleId: null,
    })
    expect(text).toContain(
      'sudo useradd --system --user-group --create-home --home-dir /var/lib/clawboo-agent --shell /bin/bash clawboo-agent',
    )
    expect(text).toContain('sudo passwd -l clawboo-agent')
    expect(text).toContain("'alice ALL=(clawboo-agent) NOPASSWD: ALL'")
    expect(text).toContain('sudo visudo -cf /etc/sudoers.d/clawboo')
    expect(text).toContain('CLAWBOO_AGENT_USER=clawboo-agent clawboo agent-user check')
    expect(text).not.toContain('inside your home')
  })

  it('prints a macOS role account in the 450 to 499 range with a group of its own', () => {
    const text = agentUserPlan({
      ...base,
      platform: 'darwin',
      agentUser: '_clawboo',
      agentHome: '/var/clawboo-agent',
      roleId: 499,
      serverHome: '/Users/alice',
      nodePath: '/Users/alice/.nvm/versions/node/v22/bin/node',
    })
    expect(text).toContain('sudo dscl . -create /Groups/_clawboo PrimaryGroupID 499')
    expect(text).toContain('-UID 499 -GID 499 -roleAccount')
    expect(text).toContain('/private/etc/sudoers.d/clawboo')
    expect(text).toContain('chmod 750 /Users/alice')
    // Node under the operator's home cannot run as the agent user.
    expect(text).toContain('inside your home')
  })

  it('refuses Windows', () => {
    expect(agentUserPlan({ ...base, platform: 'win32', agentUser: 'x', roleId: null })).toMatch(
      /WSL 2/,
    )
  })
})
