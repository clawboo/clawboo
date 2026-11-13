// The Runtimes card's "Codex connected" with agents on their own OS user: the
// agent user's own sign-in counts, read through the agent host.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', async (orig) => ({
  ...(await orig<typeof import('../../platform')>()),
  resolveRuntimeBin: () => null,
}))

import { setActiveAgentHost } from '../../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import { invalidateCodexAuthCache, isCodexLoggedIn } from '../codexAuth'

const posix = process.platform !== 'win32'

describe.runIf(posix)('Codex connected, with agents on their own OS user', () => {
  let home: string
  let h: InProcessHost | null = null
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agent-home-')))
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(
      path.join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'a' } }),
    )
    invalidateCodexAuthCache()
  })
  afterEach(() => {
    setActiveAgentHost(null)
    h?.client.close()
    h = null
    vi.unstubAllEnvs()
    invalidateCodexAuthCache()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("counts the agent user's own login", async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    expect(await isCodexLoggedIn()).toBe(true)
  })

  it('does not look there with the setting off', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    expect(await isCodexLoggedIn()).toBe(false)
  })
})
