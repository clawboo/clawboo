// One browser per agent: the properties that do not need a real Chrome.
//
// The spawn path itself is deliberately not exercised here. These suites run in
// CI and a test that reached `spawnFor` would download and launch a headed
// browser per case. What IS covered is everything that decides WHETHER to spawn
// and WHERE the profile goes, which is where the isolation actually lives:
//
//   • two agents never share a profile directory (the whole feature)
//   • an agent id that is not path-safe cannot escape the profile root
//   • the lookup-only path never creates, which is what stops the Browser panel
//     from being the thing that opens a window
//
// The routing decision (per-agent vs the one shared session) is pinned in the
// catalog suite instead, because it is enforced there: only a connector that
// declares `perAgentProfileFlag` routes per agent, and that suite asserts no
// entry outside category 'browser' declares one.

import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agentBrowserSession,
  callIfRunning,
  closeAllAgentBrowsers,
  hasAgentBrowser,
  openAgentBrowserCount,
  profileDirFor,
} from '../agentBrowsers'

let prevHome: string | undefined

const spec = {
  slug: 'playwright',
  command: 'npx',
  args: ['-y', '@playwright/mcp@0.0.79'],
  profileFlag: '--user-data-dir',
}

beforeEach(() => {
  prevHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = '/tmp/clawboo-agentbrowsers-test'
})

afterEach(async () => {
  await closeAllAgentBrowsers()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
})

describe('profile directories are what isolate one agent from another', () => {
  it('gives two agents different profiles', () => {
    // The entire point of the feature. Same directory means shared cookies,
    // which means two Boos cannot hold different logins on one site.
    expect(profileDirFor('playwright', 'a1')).not.toBe(profileDirFor('playwright', 'a2'))
  })

  it('gives one agent the SAME profile every time, so its login survives', () => {
    expect(profileDirFor('playwright', 'a1')).toBe(profileDirFor('playwright', 'a1'))
  })

  it('separates the two browser connectors, which run different browsers', () => {
    expect(profileDirFor('playwright', 'a1')).not.toBe(profileDirFor('chrome-devtools', 'a1'))
  })

  it('cannot be escaped by an agent id that is not path-safe', () => {
    // Agent ids arrive from the database and from the OpenClaw sync and are not
    // constrained to path characters. Hashing is what makes this unanswerable
    // rather than merely unlikely.
    const root = path.join('/tmp/clawboo-agentbrowsers-test', 'browser-profiles', 'playwright')
    for (const nasty of ['../../etc/passwd', 'a/../../b', '..', 'x\u0000y', 'C:\\Windows']) {
      const dir = profileDirFor('playwright', nasty)
      expect(path.resolve(dir).startsWith(path.resolve(root))).toBe(true)
      expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/)
    }
  })
})

describe('the lookup-only path never opens a browser', () => {
  it('returns null instead of creating when nothing is running', async () => {
    // This is the guarantee the Browser panel rests on: opening a panel must
    // never be the thing that puts a headed Chrome on someone's desktop.
    const session = await agentBrowserSession(spec, 'conn:playwright', 'a1', { create: false })

    expect(session).toBeNull()
    expect(hasAgentBrowser('conn:playwright', 'a1')).toBe(false)
    expect(openAgentBrowserCount()).toBe(0)
  })

  it('reports no frame rather than starting a browser to take one', async () => {
    await expect(
      callIfRunning('conn:playwright', 'a1', 'browser_take_screenshot'),
    ).resolves.toBeNull()
    expect(openAgentBrowserCount()).toBe(0)
  })

  it('counts nothing for an agent that has never browsed', () => {
    expect(hasAgentBrowser('conn:playwright', 'never-browsed')).toBe(false)
  })
})

describe('closing is safe on paths that never opened anything', () => {
  it('tolerates closing a fleet that was never started', async () => {
    // Reached by the test reset and by Disconnect on a connector whose canonical
    // entry is already gone, which is the ordinary state after a crash.
    await expect(closeAllAgentBrowsers()).resolves.toBeUndefined()
    expect(openAgentBrowserCount()).toBe(0)
  })
})
