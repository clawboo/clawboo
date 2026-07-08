// Agents REST surface + offline-tolerance. Uses the real AgentRegistry singleton
// WITHOUT starting it (so the server-side Gateway connection is "disconnected"):
// reads serve SQLite (work offline), writes/files/sessions return 503. Plus a
// regression check that 4 representative existing routes still return their shape.
// Sandboxes $HOME + CLAWBOO_HOME so the sqlite db is a throwaway.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, createDb, getSetting, teams } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { runtimeAgentFileKey } from '../../lib/agentSource/runtimeAgentFileStore'
import {
  agentsListGET,
  agentGET,
  agentsCreatePOST,
  agentsDELETE,
  agentsCleanupPOST,
  agentFileGET,
  agentFilePUT,
  agentSessionsGET,
  agentsRegistryHealthGET,
  agentModelPATCH,
} from '../agents'
import { loadAgentConfig } from '../../lib/runtimes/native/agentConfigStore'
import { teamsGET, teamsPOST } from '../teams'
import { settingsGET } from '../settings'
import { governanceAuditGET } from '../governanceAudit'
import { boardListGET } from '../board'

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

describe('agents REST (registry disconnected → reads SQLite, writes 503)', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agents-rest-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    // Seed a synced agent row (as the sync would have produced).
    const db = createDb(getDbPath())
    const now = Date.now()
    db.insert(teams)
      .values({ id: 't1', name: 'Team', icon: '👻', color: '#fff', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: 'a1',
        name: 'Research Boo',
        gatewayId: 'a1',
        sourceId: 'openclaw',
        sourceAgentId: 'a1',
        identityJson: JSON.stringify({ name: 'Research Boo', emoji: '🔬' }),
        status: 'idle',
        teamId: 't1',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('GET /api/agents reads the registry from SQLite (works offline)', async () => {
    const r = mockRes()
    await agentsListGET(req(), r.res)
    expect(r.status()).toBe(200)
    const body = r.body() as { agents: Array<{ id: string; displayName: string }>; stale: boolean }
    expect(body.agents).toHaveLength(1)
    expect(body.agents[0]?.displayName).toBe('Research Boo')
    expect(body.stale).toBe(true) // disconnected
  })

  it('GET /api/agents/:id returns the record / 404', async () => {
    const ok = mockRes()
    await agentGET(req({ params: { agentId: 'a1' } }), ok.res)
    expect(ok.status()).toBe(200)
    const miss = mockRes()
    await agentGET(req({ params: { agentId: 'nope' } }), miss.res)
    expect(miss.status()).toBe(404)
  })

  it('writes/files/sessions return 503 when the source is disconnected', async () => {
    const create = mockRes()
    await agentsCreatePOST(req({ body: { name: 'New' } }), create.res)
    expect(create.status()).toBe(503)

    const fileGet = mockRes()
    await agentFileGET(req({ params: { agentId: 'a1', name: 'TOOLS.md' } }), fileGet.res)
    expect(fileGet.status()).toBe(503)

    const filePut = mockRes()
    await agentFilePUT(
      req({ params: { agentId: 'a1', name: 'TOOLS.md' }, body: { content: 'x' } }),
      filePut.res,
    )
    expect(filePut.status()).toBe(503)

    const sessions = mockRes()
    await agentSessionsGET(req({ params: { agentId: 'a1' } }), sessions.res)
    expect(sessions.status()).toBe(503)
  })

  it('file routes reject an invalid file name (400)', async () => {
    const r = mockRes()
    await agentFileGET(req({ params: { agentId: 'a1', name: 'secrets.env' } }), r.res)
    expect(r.status()).toBe(400)
  })

  it('DELETE /api/agents/:id falls back to SQLite-only cleanup when disconnected', async () => {
    const r = mockRes()
    await agentsDELETE(req({ params: { agentId: 'a1' } }), r.res)
    expect(r.status()).toBe(200)
    expect((r.body() as { upstreamDeleted: boolean }).upstreamDeleted).toBe(false)
    // Row is gone from SQLite.
    const after = mockRes()
    await agentGET(req({ params: { agentId: 'a1' } }), after.res)
    expect(after.status()).toBe(404)
  })

  it('GET /api/agents/registry/health always 200 (reports disconnected)', async () => {
    const r = mockRes()
    await agentsRegistryHealthGET(req(), r.res)
    expect(r.status()).toBe(200)
    expect((r.body() as { connection: string }).connection).toBe('disconnected')
  })

  // ── Multi-source: the native peer source flows through the same REST ───────
  it('POST /api/agents with sourceId clawboo-native creates a native agent (works offline)', async () => {
    const create = mockRes()
    await agentsCreatePOST(
      req({
        body: { name: 'Native Peer', sourceId: 'clawboo-native', execConfig: { maxTurns: 4 } },
      }),
      create.res,
    )
    expect(create.status()).toBe(201)
    const created = (create.body() as { agent: { id: string; sourceId: string; runtime: string } })
      .agent
    expect(created).toMatchObject({ sourceId: 'clawboo-native', runtime: 'clawboo-native' })

    // GET /api/agents aggregates BOTH sources.
    const list = mockRes()
    await agentsListGET(req(), list.res)
    const body = list.body() as { agents: Array<{ id: string; sourceId: string }> }
    expect(body.agents.map((a) => a.sourceId).sort()).toEqual(['clawboo-native', 'openclaw'])

    // Per-agent routes route by the row's sourceId — native files work offline
    // (the OpenClaw source would have 503'd).
    const filePut = mockRes()
    await agentFilePUT(
      req({ params: { agentId: created.id, name: 'SOUL.md' }, body: { content: '# native soul' } }),
      filePut.res,
    )
    expect(filePut.status()).toBe(200)
    const fileGet = mockRes()
    await agentFileGET(req({ params: { agentId: created.id, name: 'SOUL.md' } }), fileGet.res)
    expect((fileGet.body() as { content: string }).content).toBe('# native soul')

    const sessions = mockRes()
    await agentSessionsGET(req({ params: { agentId: created.id } }), sessions.res)
    expect(sessions.status()).toBe(200)

    // DELETE routes to the native source (hard delete, no Gateway involved).
    const del = mockRes()
    await agentsDELETE(req({ params: { agentId: created.id } }), del.res)
    expect(del.status()).toBe(200)
    const after = mockRes()
    await agentGET(req({ params: { agentId: created.id } }), after.res)
    expect(after.status()).toBe(404)
  })

  it('PATCH /api/agents/:id/model persists a native agent model; 404 for non-native + unknown', async () => {
    // Create a native agent, then re-point its model.
    const create = mockRes()
    await agentsCreatePOST(
      req({ body: { name: 'Model Peer', sourceId: 'clawboo-native' } }),
      create.res,
    )
    const id = (create.body() as { agent: { id: string } }).agent.id

    const patch = mockRes()
    await agentModelPATCH(
      req({ params: { agentId: id }, body: { model: 'claude-haiku-4-5' } }),
      patch.res,
    )
    expect(patch.status()).toBe(200)
    expect(patch.body()).toEqual({ ok: true, model: 'claude-haiku-4-5' })
    // The AgentConfig KV row carries the new primaryModel.
    const db = createDb(getDbPath())
    expect(loadAgentConfig(db, id)?.primaryModel).toBe('claude-haiku-4-5')

    // The OpenClaw-seeded agent (a1) is not native → 404 (model change is native-only).
    const nonNative = mockRes()
    await agentModelPATCH(req({ params: { agentId: 'a1' }, body: { model: 'x' } }), nonNative.res)
    expect(nonNative.status()).toBe(404)

    // Unknown agent → 404.
    const unknown = mockRes()
    await agentModelPATCH(req({ params: { agentId: 'nope' }, body: { model: 'x' } }), unknown.res)
    expect(unknown.status()).toBe(404)

    // Empty model → 400.
    const empty = mockRes()
    await agentModelPATCH(req({ params: { agentId: id }, body: { model: '  ' } }), empty.res)
    expect(empty.status()).toBe(400)
  })

  it('POST /api/agents 400s an unknown sourceId', async () => {
    const r = mockRes()
    await agentsCreatePOST(req({ body: { name: 'X', sourceId: 'not-a-source' } }), r.res)
    expect(r.status()).toBe(400)
  })

  // ── Multi-source: a coding-runtime record source (claude-code) ─────────────
  it('POST /api/agents with sourceId claude-code round-trips offline (create → GET → files → DELETE)', async () => {
    const create = mockRes()
    await agentsCreatePOST(req({ body: { name: 'Coder Peer', sourceId: 'claude-code' } }), create.res)
    expect(create.status()).toBe(201)
    const created = (create.body() as { agent: { id: string; sourceId: string; runtime: string } })
      .agent
    expect(created).toMatchObject({ sourceId: 'claude-code', runtime: 'claude-code' })

    // GET aggregates all registered sources.
    const list = mockRes()
    await agentsListGET(req(), list.res)
    const body = list.body() as { agents: Array<{ sourceId: string }> }
    expect(body.agents.map((a) => a.sourceId).sort()).toEqual(['claude-code', 'openclaw'])

    // File PUT/GET route to the coding source (work offline) + persist to the
    // runtime-file KV.
    const filePut = mockRes()
    await agentFilePUT(
      req({ params: { agentId: created.id, name: 'SOUL.md' }, body: { content: '# coder' } }),
      filePut.res,
    )
    expect(filePut.status()).toBe(200)
    const db = createDb(getDbPath())
    const fileKey = runtimeAgentFileKey(created.id, 'SOUL.md')
    expect(getSetting(db, fileKey)).toBe('# coder')

    // cleanup-ghosts (scoped to openclaw) spares the coding row.
    const sweep = mockRes()
    agentsCleanupPOST(req({ body: { liveAgentIds: ['a1'] } }), sweep.res)
    expect((sweep.body() as { deleted: number }).deleted).toBe(0)

    // DELETE routes to the coding source + wipes the runtime-file KV.
    const del = mockRes()
    await agentsDELETE(req({ params: { agentId: created.id } }), del.res)
    expect(del.status()).toBe(200)
    const after = mockRes()
    await agentGET(req({ params: { agentId: created.id } }), after.res)
    expect(after.status()).toBe(404)
    expect(getSetting(db, fileKey)).toBeNull()
  })

  it('POST /api/teams {serverOrchestrated:true} sets the explicit flag (leaderless native team)', () => {
    const create = mockRes()
    teamsPOST(
      req({
        body: { name: 'Native Team', icon: '🚀', color: '#fff', serverOrchestrated: true },
      }),
      create.res,
    )
    const team = (create.body() as { team: { id: string; serverOrchestrated: boolean } }).team
    expect(team.serverOrchestrated).toBe(true)
    // GET re-reads the flag (no agents needed → inference alone would be false).
    const get = mockRes()
    teamsGET(req(), get.res)
    const got = (
      get.body() as { teams: Array<{ id: string; serverOrchestrated: boolean }> }
    ).teams.find((t) => t.id === team.id)
    expect(got?.serverOrchestrated).toBe(true)
  })

  it('cleanup-ghosts spares native agents (the Gateway live-id list scopes to openclaw rows)', async () => {
    const create = mockRes()
    await agentsCreatePOST(
      req({ body: { name: 'Survivor', sourceId: 'clawboo-native' } }),
      create.res,
    )
    const nativeId = (create.body() as { agent: { id: string } }).agent.id

    // The Gateway hydration reports only its own live agents — 'a1' here. The
    // sweep must NOT treat the native row as a ghost of the Gateway.
    const sweep = mockRes()
    agentsCleanupPOST(req({ body: { liveAgentIds: ['a1'] } }), sweep.res)
    expect(sweep.status()).toBe(200)
    expect((sweep.body() as { deleted: number }).deleted).toBe(0)

    const after = mockRes()
    await agentGET(req({ params: { agentId: nativeId } }), after.res)
    expect(after.status()).toBe(200)
  })

  // ── Regression: 4 representative existing routes still return their shape ──
  it('existing routes are unaffected (teams / governance audit / settings / board)', async () => {
    const t = mockRes()
    teamsGET(req(), t.res)
    expect(t.status()).toBe(200)
    expect(Array.isArray((t.body() as { teams: unknown[] }).teams)).toBe(true)

    const g = mockRes()
    governanceAuditGET(req(), g.res)
    expect(g.status()).toBe(200)
    expect(Array.isArray((g.body() as { audit: unknown[] }).audit)).toBe(true)

    const s = mockRes()
    settingsGET(req(), s.res)
    expect(s.status()).toBe(200)
    expect(typeof (s.body() as { hasToken: boolean }).hasToken).toBe('boolean')

    const b = mockRes()
    boardListGET(req(), b.res)
    expect(b.status()).toBe(200)
    expect(Array.isArray((b.body() as { tasks: unknown[] }).tasks)).toBe(true)
  })
})
