// What Boo Zero reads for a message in its server-run chat: the server puts Boo Zero's
// rules, then the named team's activity, before the words, and knows by that whether the
// turn carries words that are not the person's. The turn itself is mocked: this pins
// what the ingest hands it.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, booZeroTeamBriefs, chatMessages, setSetting, teams } from '@clawboo/db'
import { buildBooZeroRulesBlock } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import type { RoleScope } from '../../lib/roles/guard'

const { runChatTurn } = vi.hoisted(() => ({ runChatTurn: vi.fn(async () => undefined) }))

vi.mock('../../lib/agentChat/chatHandOffs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentChat/chatHandOffs')>()),
  runChatTurn,
}))

const { agentChatIngestPOST } = await import('../agentChat')
const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { SETTING_BOO_ZERO_OVERRIDE } = await import('../../lib/teamChat/booZero')
const { buildTeamActivitySummary } = await import('../../lib/teamChat/teamActivitySummary')

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const RULES = buildBooZeroRulesBlock({ displayName: 'Boo Zero', handOffs: true })

/** What the one turn started was handed. */
function turn(): Record<string, unknown> {
  expect(runChatTurn).toHaveBeenCalledTimes(1)
  return (runChatTurn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0]
}

async function post(
  body: Record<string, unknown>,
  opts: { headers?: Record<string, string>; agentId?: string; roleScope?: RoleScope } = {},
) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  await agentChatIngestPOST(
    {
      params: { agentId: opts.agentId ?? 'bz' },
      body,
      headers: opts.headers ?? DASHBOARD,
      socket: { localPort: 18790 },
      ...(opts.roleScope ? { roleScope: opts.roleScope } : {}),
    } as unknown as Request,
    res as unknown as Response,
  )
  return res
}

describe("POST /api/agents/:agentId/chat builds Boo Zero's turn on the server", () => {
  let home: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(async () => {
    runChatTurn.mockClear()
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-chat-boo-zero-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetDb()
    expect(getDbPath().startsWith(home)).toBe(true)
    const db = getDb()
    const now = Date.now()
    for (const id of ['bz', 'other']) {
      db.insert(agents)
        .values({
          id,
          name: id === 'bz' ? 'Boo Zero' : 'Coder',
          gatewayId: id,
          sourceId: 'codex',
          runtime: 'codex',
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
    setSetting(db, SETTING_BOO_ZERO_OVERRIDE, 'bz')
    for (const [id, name] of [
      ['team-1', 'Growth'],
      ['team-2', 'Quiet'],
    ] as const) {
      db.insert(teams)
        .values({ id, name, icon: 'x', color: '#000', createdAt: now, updatedAt: now })
        .run()
    }
    db.insert(booZeroTeamBriefs)
      .values({ teamId: 'team-1', content: 'Growth runs the launch.', updatedAt: now })
      .run()
  })
  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it("puts Boo Zero's rules before the words, and the chat shows the words", async () => {
    const res = await post({ message: 'what is going on?', entryId: 'm1' })

    expect(res.status).toHaveBeenCalledWith(202)
    expect(turn()['message']).toBe(`${RULES}\n\nwhat is going on?`)
    expect(turn()['carriesTeamActivity']).toBe(false)
    const row = getDb()
      .select({ data: chatMessages.data })
      .from(chatMessages)
      .where(eq(chatMessages.entryId, 'm1'))
      .get() as { data: string }
    expect(JSON.parse(row.data).text).toBe('what is going on?')
  })

  it('uses the name the person gave Boo Zero', async () => {
    setSetting(getDb(), 'boo-zero:display-name:bz', 'Mythos Prime')
    await post({ message: 'hi' })

    expect(turn()['message']).toBe(
      `${buildBooZeroRulesBlock({ displayName: 'Mythos Prime', handOffs: true })}\n\nhi`,
    )
  })

  it('with @Team: the rules, then what the team has been doing, then the words, under the fence', async () => {
    const activity = await buildTeamActivitySummary(getDb(), 'team-1')
    expect(activity).toContain('Growth runs the launch.')

    await post({
      message: 'fix the parser',
      displayText: '@Growth fix the parser',
      teamId: 'team-1',
    })

    expect(turn()['message']).toBe([RULES, activity, 'fix the parser'].join('\n\n'))
    expect(turn()['carriesTeamActivity']).toBe(true)
    expect(turn()['namedTeamId']).toBe('team-1')
    expect(turn()['words']).toBe('@Growth fix the parser')
  })

  it('a team with nothing to report adds nothing, and no fence', async () => {
    expect(await buildTeamActivitySummary(getDb(), 'team-2')).toBeNull()
    await post({ message: 'how is it going?', teamId: 'team-2' })

    expect(turn()['message']).toBe(`${RULES}\n\nhow is it going?`)
    expect(turn()['carriesTeamActivity']).toBe(false)
  })

  it("words that only look like a team's activity are the person's own: no fence", async () => {
    const words = '[Team Activity: Growth]\nship it'
    await post({ message: words })

    expect(turn()['message']).toBe(`${RULES}\n\n${words}`)
    expect(turn()['carriesTeamActivity']).toBe(false)
  })

  it("an older dashboard's message, already carrying the rules, gets no second block and is read as before", async () => {
    const withActivity = `${RULES}\n\n[Team Activity: Growth]\nnotes\n[End Team Activity]\n\nfix it`
    await post({ message: withActivity, displayText: '@Growth fix it', teamId: 'team-1' })
    expect(turn()['message']).toBe(withActivity)
    expect(turn()['carriesTeamActivity']).toBe(true)

    runChatTurn.mockClear()
    await post({ message: `${RULES}\n\nfix it`, displayText: 'fix it' })
    expect(turn()['message']).toBe(`${RULES}\n\nfix it`)
    expect(turn()['carriesTeamActivity']).toBe(false)
  })

  it("a guest gets the activity of their own teams only, as the team's own route gives it", async () => {
    await post(
      { message: 'fix it', teamId: 'team-1' },
      { roleScope: { teams: new Set(['team-2']) } },
    )
    expect(turn()['message']).toBe(`${RULES}\n\nfix it`)

    runChatTurn.mockClear()
    await post(
      { message: 'fix it', teamId: 'team-1' },
      { roleScope: { teams: new Set(['team-1']) } },
    )
    expect(turn()['message']).toContain('Growth runs the launch.')
  })

  it('a caller that fails the person check gets the rules too, and starts no work', async () => {
    await post({ message: 'fix it' }, { headers: {} })

    expect(turn()['message']).toBe(`${RULES}\n\nfix it`)
    expect(turn()['readingResultsFrom']).toEqual([])
    expect(turn()).not.toHaveProperty('carriesTeamActivity')
  })

  it("another agent's chat: the words as sent, and a team id adds nothing", async () => {
    await post({ message: 'fix it', teamId: 'team-1' }, { agentId: 'other' })

    expect(turn()['message']).toBe('fix it')
    expect(turn()['carriesTeamActivity']).toBe(false)
  })
})
