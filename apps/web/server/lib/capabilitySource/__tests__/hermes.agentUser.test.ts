// The Hermes capability view with agents on their own OS user
// (CLAWBOO_AGENT_USER): the Hermes homes runs use are under that user's home,
// not the data folder, and they are agent space, so the view lists and reads
// them through the agent host.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveAgentHost } from '../../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import { HermesCapabilitySource } from '../hermes'

const posix = process.platform !== 'win32'

let tmp: string
let active: InProcessHost | null = null

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-caps-agent-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  active?.client.close()
  active = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.runIf(posix)('HermesCapabilitySource with agents on their own OS user', () => {
  it("reads the agent user's Hermes homes through the agent host", async () => {
    const dataDir = path.join(tmp, '.clawboo')
    const agentHome = path.join(tmp, 'agent')
    // The runs' home for h1, in agent space.
    const home = path.join(agentHome, 'runtimes', 'hermes', 'h1')
    fs.mkdirSync(path.join(home, 'skills', 'web-fetch'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'skills', 'web-fetch', 'SKILL.md'),
      '---\nname: Web Fetch\ndescription: Fetch a URL\n---\n# body',
    )
    fs.writeFileSync(
      path.join(home, 'config.yaml'),
      'mcp_servers:\n  custom-srv:\n    url: "http://y"\n',
    )
    // A stale copy the data folder still holds from before the setting.
    fs.mkdirSync(path.join(dataDir, 'runtimes', 'hermes', 'old'), { recursive: true })

    vi.stubEnv('CLAWBOO_HOME', dataDir)
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const h = startInProcessHost()
    active = h
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home: agentHome },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    const ops: string[] = []
    const request = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation((r, opts) => {
      ops.push(r.op)
      return request(r, opts)
    })

    const { records, status } = await new HermesCapabilitySource().read()

    expect(status.ok).toBe(true)
    expect(records.find((r) => r.kind === 'skill')).toMatchObject({
      name: 'Web Fetch',
      description: 'Fetch a URL',
      agentId: 'h1',
    })
    expect(records.filter((r) => r.kind === 'connector').map((r) => r.name)).toEqual(['custom-srv'])
    expect(records.some((r) => r.agentId === 'old')).toBe(false)
    expect(ops).toEqual(expect.arrayContaining(['fs.list', 'fs.read']))
  })

  it('reports no homes, not an error, when the agent host is not running', async () => {
    vi.stubEnv('CLAWBOO_HOME', path.join(tmp, '.clawboo'))
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const { records, status } = await new HermesCapabilitySource().read()
    expect(status.ok).toBe(true)
    expect(records.map((r) => r.kind)).not.toContain('skill')
  })
})
