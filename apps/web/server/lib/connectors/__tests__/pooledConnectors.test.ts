// With a user per agent (CLAWBOO_AGENT_USERS), which connectors may start: a
// shared one with local reach would be one process for every agent, so it does
// not; a per-agent browser or desktop driver does (its shared process only
// lists tools); a credentialed one stays with the server as always.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isPerAgentLaunch, pooledConnectorRefusal } from '../agentBrowsers'

describe('pooledConnectorRefusal', () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env['CLAWBOO_AGENT_USERS']
    process.env['CLAWBOO_AGENT_USERS'] = 'clawboo-a1,clawboo-a2'
  })
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAWBOO_AGENT_USERS']
    else process.env['CLAWBOO_AGENT_USERS'] = prev
  })

  it('lets a per-agent browser start: a profile flag makes it per agent', () => {
    const browser = { perAgentProfileFlag: '--user-data-dir' }
    expect(isPerAgentLaunch(browser)).toBe(true)
    expect(pooledConnectorRefusal('Playwright', {}, isPerAgentLaunch(browser))).toBeNull()
  })

  it('lets a desktop driver start, and a credentialed connector', () => {
    expect(
      pooledConnectorRefusal('Cua Driver', {}, isPerAgentLaunch({ perAgentDisplay: true })),
    ).toBeNull()
    expect(pooledConnectorRefusal('GitHub', { GITHUB_TOKEN: 'x' }, false)).toBeNull()
  })

  it('refuses a shared connector with local reach', () => {
    expect(isPerAgentLaunch({})).toBe(false)
    expect(pooledConnectorRefusal('Filesystem', {}, isPerAgentLaunch({}))).toMatch(
      /one program shared by every agent/,
    )
  })
})
