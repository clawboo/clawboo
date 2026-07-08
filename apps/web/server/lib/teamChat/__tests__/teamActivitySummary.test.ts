// buildTeamActivitySummary — the on-demand "what has this team been doing" block for
// Boo Zero's @team personal-chat injection. Asserts it pulls the brief + board + recent
// chat from durable SERVER state, drops meta / relay / malformed / control-token turns,
// returns null for an untouched team, and that the REST handler serves it.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  booZeroTeamBriefs,
  chatMessages,
  createDb,
  createTask,
  SqliteMemoryStore,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import type { Request, Response } from 'express'

import { teamActivitySummaryGET } from '../../../api/teamActivity'
import { getDbPath } from '../../db'
import { buildTeamActivitySummary } from '../teamActivitySummary'

const TEAM = 'team-1'

describe('buildTeamActivitySummary', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb
  let seq = 0

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-teamactivity-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = createDb(getDbPath())
    seq = 0
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function team(id: string, name: string): void {
    const now = Date.now()
    db.insert(teams)
      .values({ id, name, icon: '📢', color: '#fff', createdAt: now, updatedAt: now })
      .run()
  }
  function agent(id: string, name: string, teamId: string | null): void {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name,
        gatewayId: id,
        sourceId: 'clawboo-native',
        sourceAgentId: id,
        runtime: 'clawboo-native',
        status: 'idle',
        teamId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
  function chat(sessionKey: string, data: unknown): void {
    seq += 1
    db.insert(chatMessages)
      .values({
        sessionKey,
        gatewayUrl: 'native',
        entryId: `e${seq}`,
        timestampMs: seq,
        data: typeof data === 'string' ? data : JSON.stringify(data),
      })
      .run()
  }
  function brief(teamId: string, content: string): void {
    db.insert(booZeroTeamBriefs).values({ teamId, content, updatedAt: Date.now() }).run()
  }

  it('composes brief + board + saved memory + recent chat and filters noise', async () => {
    team(TEAM, 'Marketing Squad')
    agent('m1', 'Weibo Strategist', TEAM)
    agent('m2', 'Zhihu Strategist', TEAM)
    brief(TEAM, 'Own the China social launch.')
    createTask(db, { title: 'Draft the Weibo campaign', status: 'done', teamId: TEAM })
    createTask(db, { title: 'Write Zhihu long-form', status: 'in_progress', teamId: TEAM })
    // Saved team memory (team-scoped) + a global fact that must NOT leak in.
    const mem = new SqliteMemoryStore(db)
    await mem.saveFact({ title: 'Brand voice', content: 'Playful, punchy, culturally fluent.', scope: { teamId: TEAM } })
    await mem.saveFact({ title: 'Global note', content: 'unrelated cross-team fact', scope: {} })

    const k1 = buildTeamSessionKey('m1', TEAM)
    const k2 = buildTeamSessionKey('m2', TEAM)
    chat(k1, { kind: 'assistant', role: 'assistant', text: 'Weibo campaign draft is ready.', sessionKey: k1 })
    chat(k2, { kind: 'meta', role: 'system', text: 'session note — should be dropped', sessionKey: k2 })
    chat(k1, { kind: 'assistant', role: 'assistant', text: '[Team Update] batched status', sessionKey: k1 })
    chat(k2, 'not-json{') // malformed — must be skipped, not sink the summary
    chat(k2, { kind: 'assistant', role: 'assistant', text: 'Zhihu piece is 80% done.', sessionKey: k2 })

    const out = await buildTeamActivitySummary(db, TEAM)
    expect(out).not.toBeNull()
    const s = out as string
    // Header + brief.
    expect(s).toContain('[Team Activity: Marketing Squad]')
    expect(s).toContain('Own the China social launch.')
    // Board: counts + a task title.
    expect(s).toContain('1 done')
    expect(s).toContain('1 in progress')
    expect(s).toContain('Draft the Weibo campaign (done)')
    // Saved memory: the team-scoped fact, NOT the global one.
    expect(s).toContain('Saved knowledge:')
    expect(s).toContain('Brand voice: Playful, punchy, culturally fluent.')
    expect(s).not.toContain('unrelated cross-team fact')
    // Recent chat: the real turns, NOT the meta / relay / malformed ones.
    expect(s).toContain('Weibo campaign draft is ready.')
    expect(s).toContain('Zhihu piece is 80% done.')
    expect(s).not.toContain('session note')
    expect(s).not.toContain('[Team Update]')
    expect(s).not.toContain('not-json')
  })

  it('returns null for an untouched team (no brief, no board, no memory, no chat)', async () => {
    team(TEAM, 'Empty Team')
    agent('m1', 'Member', TEAM)
    expect(await buildTeamActivitySummary(db, TEAM)).toBeNull()
  })

  it('returns null for an unknown team', async () => {
    expect(await buildTeamActivitySummary(db, 'nope')).toBeNull()
  })

  it('the REST handler serves the summary (200 with content)', async () => {
    team(TEAM, 'Marketing Squad')
    agent('m1', 'Weibo Strategist', TEAM)
    brief(TEAM, 'Own the China social launch.')

    let status = 200
    let body: unknown
    const res = {
      status(c: number) {
        status = c
        return this
      },
      json(b: unknown) {
        body = b
        return this
      },
    } as unknown as Response
    const req = { params: { id: TEAM } } as unknown as Request
    await teamActivitySummaryGET(req, res)
    expect(status).toBe(200)
    expect(typeof (body as { content?: unknown }).content).toBe('string')
    expect((body as { content: string }).content).toContain('Own the China social launch.')
  })
})
