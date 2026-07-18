// teamAgentPOST → eager native Boo Zero. THE regression guard for "my first team is
// unresponsive and led by the OpenClaw `main`".
//
// `createAgent` (the CreateTeamModal deploy path) has no `teamId` parameter: it creates
// every agent TEAMLESS and assigns it via POST /api/teams/:id/agents. So the sibling
// hook in `agentsCreatePOST` — gated on `agent.teamId` — can never fire for it, and
// before this fix NOTHING created the DEFAULT-NATIVE Boo Zero at deploy time. It only
// appeared on the team's FIRST MESSAGE (the orchestrator's `ready` chain) — too late for
// that team (its client had already hydrated `defaultId` as the OpenClaw `main` fallback
// and pinned it as the chat target), but just in time for every team created after it.
// That is exactly why team #1 broke while team #2 worked.
//
// Uses the real AgentRegistry singleton WITHOUT starting it: the native source is pure
// SQLite, so it works with no Gateway connection. Sandboxes $HOME + CLAWBOO_HOME.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, createDb, setSetting, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { SETTING_DEFAULT_ID } from '../../lib/agentSource/openClawAgentSource'
import { resolveBooZero, resolveNativeBooZero } from '../../lib/teamChat/booZero'
import { agentsCreatePOST } from '../agents'
import { teamAgentPOST } from '../teams'

const NATIVE_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'OLLAMA_BASE_URL',
]

interface AgentRow {
  id: string
  runtime: string | null
  teamId: string | null
}

function mockRes(): { res: Response; status: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, status: () => code, body: () => payload }
}
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

describe('teamAgentPOST → eager native Boo Zero', () => {
  let home: string
  let prevHome: string | undefined
  const savedKeys: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-team-agent-bz-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    // Deterministic provider gate — the dev machine's real env may carry a key.
    for (const v of NATIVE_KEY_VARS) {
      savedKeys[v] = process.env[v]
      delete process.env[v]
    }
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key'
    db = createDb(getDbPath())
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    for (const v of NATIVE_KEY_VARS) {
      if (savedKeys[v] === undefined) delete process.env[v]
      else process.env[v] = savedKeys[v]
    }
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function makeTeam(id: string): void {
    const now = Date.now()
    db.insert(teams)
      .values({ id, name: id, icon: '👻', color: '#fff', createdAt: now, updatedAt: now })
      .run()
  }

  /** A teamless OpenClaw agent. `main` + the Gateway defaultId is the fallback that
   *  used to hijack the lead of a freshly-deployed native team. */
  function makeOpenClawAgent(id: string, teamId: string | null = null): void {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: 'openclaw',
        sourceAgentId: id,
        runtime: 'openclaw',
        status: 'idle',
        teamId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  function makeOpenClawMain(): void {
    makeOpenClawAgent('main')
    setSetting(db, SETTING_DEFAULT_ID, 'main')
  }

  function agentRow(id: string): AgentRow | undefined {
    return db.select().from(agents).where(eq(agents.id, id)).get() as AgentRow | undefined
  }

  /** Create a teamless native agent exactly the way `createAgent` does (no teamId). */
  async function createNativeAgentTeamless(name: string): Promise<string> {
    const { res, status, body } = mockRes()
    await agentsCreatePOST(
      req({ body: { name, sourceId: 'clawboo-native', execConfig: { modelTier: 'specialist' } } }),
      res,
    )
    expect(status()).toBe(201)
    const agent = (body() as { agent: { id: string; teamId: string | null } }).agent
    // The precondition this whole bug rests on: the deploy path creates TEAMLESS agents,
    // so `agentsCreatePOST`'s own `agent.teamId`-gated hook cannot fire.
    expect(agent.teamId).toBeNull()
    return agent.id
  }

  it('creates the teamless native Boo Zero when a team gains its first NATIVE member', async () => {
    makeTeam('team-1')
    const agentId = await createNativeAgentTeamless('Captain Boo')

    // Precondition: nothing has created a native Boo Zero yet.
    expect(resolveNativeBooZero(db)).toBeNull()

    const { res, status } = mockRes()
    await teamAgentPOST(req({ params: { id: 'team-1' }, body: { agentId } }), res)
    expect(status()).toBe(200)

    const bz = resolveNativeBooZero(db)
    expect(bz).not.toBeNull()
    // Boo Zero must be TEAMLESS — it presides over every team.
    const row = agentRow(bz!.id)
    expect(row?.teamId).toBeNull()
    expect(row?.runtime).toBe('clawboo-native')
    // And the member itself actually landed on the team.
    expect(agentRow(agentId)?.teamId).toBe('team-1')
  })

  it('THE regression: the native Boo Zero wins over an existing OpenClaw `main`', async () => {
    makeTeam('team-1')
    makeOpenClawMain()

    // Before the team gains a native member, `main` is the only Boo Zero — this is the
    // state the first team's client used to hydrate and pin as its chat target.
    expect(resolveBooZero(db)?.id).toBe('main')

    const agentId = await createNativeAgentTeamless('Captain Boo')
    const { res } = mockRes()
    await teamAgentPOST(req({ params: { id: 'team-1' }, body: { agentId } }), res)

    // After assignment, `defaultId` (= resolveBooZero) is the NATIVE Boo Zero, so the
    // client hydrates the right leader and never routes the first message to `main`.
    const bz = resolveBooZero(db)
    expect(bz).not.toBeNull()
    expect(bz!.id).not.toBe('main')
    expect(bz!.id).toBe(resolveNativeBooZero(db)?.id)
  })

  it('is idempotent — assigning more native members reuses the same Boo Zero', async () => {
    makeTeam('team-1')
    const a1 = await createNativeAgentTeamless('Captain Boo')
    const a2 = await createNativeAgentTeamless('Pixel Boo')

    const r1 = mockRes()
    await teamAgentPOST(req({ params: { id: 'team-1' }, body: { agentId: a1 } }), r1.res)
    const first = resolveNativeBooZero(db)?.id

    const r2 = mockRes()
    await teamAgentPOST(req({ params: { id: 'team-1' }, body: { agentId: a2 } }), r2.res)
    const second = resolveNativeBooZero(db)?.id

    expect(first).toBeTruthy()
    expect(second).toBe(first)
    const nativeTeamless = (db.select().from(agents).all() as AgentRow[]).filter(
      (a) => a.runtime === 'clawboo-native' && a.teamId === null,
    )
    expect(nativeTeamless).toHaveLength(1)
  })

  it('creates NOTHING for an OpenClaw member (a pure-OpenClaw install keeps its own leader)', async () => {
    makeTeam('team-1')
    makeOpenClawMain() // stays TEAMLESS — it is the Gateway default, not a team member
    makeOpenClawAgent('oc-writer')

    // An OpenClaw agent joining a team must not materialize a native leader.
    const { res, status } = mockRes()
    await teamAgentPOST(req({ params: { id: 'team-1' }, body: { agentId: 'oc-writer' } }), res)
    expect(status()).toBe(200)
    expect(agentRow('oc-writer')?.teamId).toBe('team-1')
    expect(resolveNativeBooZero(db)).toBeNull()
    // The install keeps the OpenClaw default as its Boo Zero — unchanged.
    expect(resolveBooZero(db)?.id).toBe('main')
  })

  it('creates NOTHING when no native provider key is connected', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    makeTeam('team-1')
    const agentId = await createNativeAgentTeamless('Captain Boo')
    const { res } = mockRes()
    await teamAgentPOST(req({ params: { id: 'team-1' }, body: { agentId } }), res)
    // Without a key a native agent cannot run — don't materialize an unrunnable leader.
    expect(resolveNativeBooZero(db)).toBeNull()
  })
})
