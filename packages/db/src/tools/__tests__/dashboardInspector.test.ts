// The broker refuses a connector call that points at the Clawboo dashboard.
//
// The dashboard has no access check on loopback, so an agent driving a browser
// there could approve its own requests or give itself connectors. The browsers
// are launched with the dashboard blocked; this is the second line, and it also
// covers any other tool that takes a URL. Hosts are read the way a browser
// reads them, so the numeric, escaped and full-width spellings of 127.0.0.1
// and localhost do not slip past.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDb, type ClawbooDb } from '../../db'
import { upsertGrant } from '../../grants/repository'
import { defaultAvailabilityContext } from '../availability'
import { executeBrokeredCall } from '../broker'
import { dashboardInspector, setDashboardPorts } from '../inspectors'
import { ToolRegistry } from '../registry'
import type { ToolCallContext, ToolDescriptor } from '../types'

const ctx = { availability: defaultAvailabilityContext({ env: {} }) } as ToolCallContext
const decide = async (args: Record<string, unknown>) =>
  (await dashboardInspector({ name: 'mcp__playwright__browser_navigate', args }, {} as never, ctx))
    .kind

beforeEach(() => setDashboardPorts([18790]))
afterEach(() => setDashboardPorts([]))

describe('dashboardInspector', () => {
  it.each([
    'http://127.0.0.1:18790/',
    'http://localhost:18790/#/approvals',
    'localhost:18790',
    'http://localhost.:18790',
    'http://[::1]:18790/',
    'http://0.0.0.0:18790',
    'http://2130706433:18790/',
    'http://0x7f.1:18790/',
    'http://127.0.0.2:18790/',
    'http://app.localhost:18790/',
    'http://[::ffff:127.0.0.1]:18790/',
    'http://[::ffff:0.0.0.0]:18790/',
  ])('refuses %s', async (url) => {
    expect(await decide({ url })).toBe('deny')
  })

  // A URL parser decodes these before it connects, so each one opens the
  // dashboard as surely as the plain spelling does.
  it.each([
    ['percent escapes', 'http://%6c%6fcalhost:18790/'],
    ['a percent-escaped digit', 'http://127.0.0.%31:18790/'],
    ['full-width letters', 'http://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54:18790/'],
    ['full-width digits', 'http://\uff11\uff12\uff17.\uff10.\uff10.\uff11:18790/'],
    ['ideographic full stops', 'http://127\u30020\u30020\u30021:18790/'],
    ['a leading zero on the port', 'http://localhost:018790/'],
    ['a tab inside the name', 'http://local\thost:18790/'],
    ['a line break inside the address', 'http://127.0.\n0.1:18790/'],
  ])('refuses %s', async (_label, url) => {
    expect(await decide({ url })).toBe('deny')
  })

  it('still refuses a plain name run into other text', async () => {
    expect(await decide({ text: 'open \u6253\u5f00localhost:18790 now' })).toBe('deny')
  })

  it('looks inside nested arguments', async () => {
    expect(await decide({ action: 'new', tabs: [{ url: 'http://localhost:18790' }] })).toBe('deny')
  })

  it.each([
    'http://localhost:3000/',
    'https://example.com:18790/',
    'http://192.168.1.5:18790/',
    'open the page on port 18790',
  ])('lets %s through', async (url) => {
    expect(await decide({ url })).toBe('allow')
  })

  it('refuses an over-long localhost name on the dashboard port', async () => {
    expect(await decide({ url: `http://${'a'.repeat(300)}.localhost:18790/` })).toBe('deny')
  })

  it('reads a very long run of host characters quickly, and passes it', async () => {
    const started = performance.now()
    expect(await decide({ url: '-'.repeat(200_000) })).toBe('allow')
    expect(await decide({ url: `${'a.'.repeat(50_000)}x` })).toBe('allow')
    expect(await decide({ url: '%\uff41'.repeat(100_000) })).toBe('allow')
    expect(await decide({ url: `${'\uff41'.repeat(100_000)}:18790` })).toBe('allow')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('does nothing before the server has said which port the dashboard uses', async () => {
    setDashboardPorts([])
    expect(await decide({ url: 'http://127.0.0.1:18790/' })).toBe('allow')
  })
})

describe('a granted browser tool cannot open the dashboard', () => {
  let dir: string
  let db: ClawbooDb
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-dashboard-inspector-'))
    db = createDb(path.join(dir, 'test.db'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is refused before it runs, whatever the grant allows', async () => {
    const CONNECTOR = 'conn:connector:clawboo:mcp:playwright'
    upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      mode: 'admin',
      approvalPolicy: 'never',
    })
    let ran = false
    const navigate: ToolDescriptor = {
      name: 'mcp__playwright__browser_navigate',
      description: 'navigate',
      inputSchema: z.object({ url: z.string() }).passthrough(),
      owner: 'mcp',
      risk: 'external',
      executor: () => {
        ran = true
        return 'ok'
      },
    }
    const registry = new ToolRegistry()
    registry.register(navigate)

    const res = await executeBrokeredCall(
      db,
      { name: navigate.name, args: { url: 'http://localhost:18790/' } },
      { ...ctx, agentId: 'a1', connectorId: CONNECTOR },
      { registry },
    )
    expect(res.ok).toBe(false)
    expect(res.denied).toMatch(/^dashboard:/)
    expect(ran).toBe(false)
  })
})
