// The Runtimes card's Hermes "connected" with agents on their own OS user: a
// sign-in made from the Runtimes page is the agent user's own, read through the
// agent host and remembered for the card's synchronous status.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveAgentHost } from '../../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import { agentHermesCodexAuthSeen, refreshAgentHermesCodexAuth } from '../hermesAuth'

const posix = process.platform !== 'win32'

describe.runIf(posix)('Hermes connected, with agents on their own OS user', () => {
  let home: string
  let h: InProcessHost | null = null
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-home-')))
    fs.mkdirSync(path.join(home, '.hermes'))
    fs.writeFileSync(
      path.join(home, '.hermes', 'auth.json'),
      JSON.stringify({ credential_pool: { 'openai-codex': [{ access_token: 'agents' }] } }),
    )
  })
  afterEach(async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    await refreshAgentHermesCodexAuth()
    setActiveAgentHost(null)
    h?.client.close()
    h = null
    vi.unstubAllEnvs()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("counts the agent user's own sign-in once refreshed", async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    expect(agentHermesCodexAuthSeen()).toBe(false)
    expect(await refreshAgentHermesCodexAuth()).toBe(true)
    expect(agentHermesCodexAuthSeen()).toBe(true)
  })

  it('never says so with the setting off', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    expect(await refreshAgentHermesCodexAuth()).toBe(false)
    expect(agentHermesCodexAuthSeen()).toBe(false)
  })
})
