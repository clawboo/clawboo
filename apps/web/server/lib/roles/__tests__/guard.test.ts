// The role guard: what each role may do on a route, and which team a guest's
// request is about, read from a real database.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  createRoom,
  createTask,
  linkDep,
  revokeGrant,
  taskQuestions,
  tasks,
  teams,
  upsertGrant,
  type ClawbooDb,
} from '@clawboo/db'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'
import type { NextFunction, Request, Response } from 'express'

import { getDb, resetDb } from '../../db'
import {
  decideRole,
  inRoleScope,
  roleGuard,
  roleRefusalBody,
  upgradeAllowedForRoles,
} from '../guard'
import { readerRefusalBody } from '../../proxyIdentity/lane'
import { READER_ROUTE_KEYS } from '../../proxyIdentity/readerRoutes'
import type { PersonAccess, Role } from '../policy'
import { ROUTE_RULES, type RouteRule } from '../rules'

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0)

function access(roles: Role[], over: Partial<PersonAccess> = {}): PersonAccess {
  return { roles, approve: false, teams: null, until: null, label: null, service: false, ...over }
}

interface ReqParts {
  params?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  access?: PersonAccess | null
  person?: boolean
  /** A service token's program instead of a person. */
  service?: boolean
  /** A reader key's program instead of a person. */
  reader?: string
}

function request({
  params = {},
  query = {},
  body,
  access,
  person = true,
  service = false,
  reader,
}: ReqParts): Request {
  const who = { id: 'p-1', name: 'Ada', role: null }
  return {
    params,
    query,
    body,
    person: person && !service && !reader ? who : null,
    service: service ? who : null,
    ...(reader ? { reader } : {}),
    access: access ?? null,
    app: { locals: { rolesMode: 'enforce' } },
  } as unknown as Request
}

function rule(key: string): RouteRule {
  const found = ROUTE_RULES[key]
  if (!found) throw new Error(`no rule for ${key}`)
  return found
}

function decide(key: string, parts: ReqParts) {
  return decideRole(request(parts), rule(key), { now: NOW })
}

describe('decideRole', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb
  let taskInT: string
  let taskInOther: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-roles-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = getDb()
    const now = Date.now()
    for (const id of ['T', 'OTHER']) {
      db.insert(teams)
        .values({ id, name: id, icon: 'T', color: '#e94560', createdAt: now, updatedAt: now })
        .run()
    }
    for (const [id, teamId] of [
      ['a1', 'T'],
      ['x1', 'OTHER'],
    ] as const) {
      db.insert(agents)
        .values({ id, name: id, gatewayId: id, teamId, createdAt: now, updatedAt: now })
        .run()
    }
    taskInT = createTask(db, { title: 'Photos', teamId: 'T' }).id
    taskInOther = createTask(db, { title: 'Ads', teamId: 'OTHER' }).id
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  describe('who may answer an approval', () => {
    const ROUTE = 'POST /api/tools/approvals/:id/resolve'
    const once = { decision: 'allow_once' }
    const always = { decision: 'allow_always' }

    it('lets the owner answer, once or always', () => {
      expect(decide(ROUTE, { access: access(['owner']), body: once }).ok).toBe(true)
      expect(decide(ROUTE, { access: access(['owner']), body: always }).ok).toBe(true)
    })

    it('never lets an operator answer', () => {
      expect(decide(ROUTE, { access: access(['operator']), body: once })).toEqual({
        ok: false,
        reason: 'not-allowed',
      })
    })

    it('lets a member answer only with approve, and never always', () => {
      expect(decide(ROUTE, { access: access(['member']), body: once }).ok).toBe(false)
      const approver = access(['member'], { approve: true })
      expect(decide(ROUTE, { access: approver, body: once }).ok).toBe(true)
      expect(decide(ROUTE, { access: approver, body: always })).toEqual({
        ok: false,
        reason: 'not-allowed',
      })
    })

    it('never lets a guest answer, even with approve in the token', () => {
      const guest = access(['guest'], { approve: true, teams: ['T'] })
      expect(decide(ROUTE, { access: guest, body: once }).ok).toBe(false)
    })
  })

  describe('what decides whether anyone is asked', () => {
    it("is the owner's as well as an operator's: an operator alone never makes agents ask less", () => {
      for (const key of [
        'POST /api/exec-settings',
        'PATCH /api/system/openclaw-config',
        'POST /api/system/configure-openclaw',
        'POST /api/system/auto-configure-openclaw',
      ]) {
        expect(decide(key, { access: access(['operator']) }), key).toEqual({
          ok: false,
          reason: 'not-allowed',
        })
        expect(decide(key, { access: access(['owner']) }).ok, key).toBe(false)
        expect(decide(key, { access: access(['owner', 'operator']) }).ok, key).toBe(true)
      }
    })

    it('re-grants a revoked grant that never asks only with the owner, even with no policy sent', () => {
      const identity = {
        subjectKind: 'agent',
        subjectId: 'a1',
        capabilityKind: 'connector',
        connectorId: 'c-regrant',
        capabilityId: null,
      } as const
      const id = upsertGrant(db, {
        ...identity,
        mode: 'write',
        approvalPolicy: 'never',
        origin: 'operator',
      }).id
      revokeGrant(db, id, null)
      const regrant = (body: Record<string, unknown>, roles: Role[]) =>
        decide('POST /api/grants', { access: access(roles), body: { ...identity, ...body } }).ok
      expect(regrant({}, ['operator'])).toBe(false)
      expect(regrant({}, ['owner', 'operator'])).toBe(true)
      expect(regrant({ approvalPolicy: 'risk' }, ['operator'])).toBe(true)
      expect(regrant({ connectorId: 'c-new' }, ['operator'])).toBe(true)
    })

    it('brings back a revoked grant that never asks only with the owner', () => {
      const grant = (approvalPolicy: 'never' | 'risk') =>
        upsertGrant(db, {
          subjectKind: 'agent',
          subjectId: 'a1',
          capabilityKind: 'connector',
          connectorId: `c-${approvalPolicy}`,
          capabilityId: null,
          mode: 'write',
          approvalPolicy,
          origin: 'operator',
        }).id
      const resume = (id: string, roles: Role[]) =>
        decide('POST /api/grants/:id/resume', { access: access(roles), params: { id } }).ok
      const never = grant('never')
      expect(resume(never, ['operator'])).toBe(false)
      expect(resume(never, ['owner', 'operator'])).toBe(true)
      expect(resume(grant('risk'), ['operator'])).toBe(true)
    })

    it('needs the owner to bring back, widen or loosen a grant by making it again', () => {
      const gmail = {
        subjectKind: 'agent',
        subjectId: 'a1',
        capabilityKind: 'connector',
        connectorId: 'gmail',
      } as const
      const made = upsertGrant(db, {
        ...gmail,
        capabilityId: null,
        mode: 'write',
        approvalPolicy: 'never',
        origin: 'operator',
      })
      revokeGrant(db, made.id, null)
      const post = (roles: Role[], body: Record<string, unknown>) =>
        decide('POST /api/grants', { access: access(roles), body }).ok
      // Making it again, with no policy, brings it back as one that never asks.
      expect(post(['operator'], gmail)).toBe(false)
      expect(post(['operator'], { ...gmail, mode: 'admin', toolAllow: ['*'] })).toBe(false)
      expect(post(['owner', 'operator'], gmail)).toBe(true)
      // Making it ask more is an operator's.
      expect(post(['operator'], { ...gmail, approvalPolicy: 'always' })).toBe(true)

      const drive = { ...gmail, connectorId: 'drive' }
      upsertGrant(db, {
        ...drive,
        capabilityId: null,
        approvalPolicy: 'always',
        origin: 'operator',
      })
      expect(post(['operator'], { ...drive, approvalPolicy: 'risk' })).toBe(false)
      expect(post(['operator'], { ...drive, approvalPolicy: 'writes' })).toBe(false)
      expect(post(['operator'], { ...drive, toolAllow: ['read_file'] })).toBe(true)
      expect(post(['owner', 'operator'], { ...drive, approvalPolicy: 'risk' })).toBe(true)

      // A new grant that asks is an operator's.
      expect(post(['operator'], { ...gmail, connectorId: 'calendar' })).toBe(true)
    })

    it("needs the owner to let a team's plans start unasked, or its agents wake each other unasked", () => {
      const cases: Array<[string, Record<string, string>, unknown, unknown]> = [
        ['PUT /api/team-plan-approval/:teamId', { teamId: 'T' }, { on: false }, { on: true }],
        ['PUT /api/team-agent-wakes/:teamId', { teamId: 'T' }, { always: true }, { always: false }],
        [
          'POST /api/board/agent-wakes/:jobTaskId',
          { jobTaskId: taskInT },
          { decision: 'team' },
          { decision: 'job' },
        ],
      ]
      for (const [key, params, asksLess, asksMore] of cases) {
        const as = (roles: Role[], body: unknown) =>
          decide(key, { access: access(roles), params, body }).ok
        expect(as(['operator'], asksLess), key).toBe(false)
        expect(as(['owner'], asksLess), key).toBe(true)
        expect(as(['operator'], asksMore), key).toBe(true)
        expect(as(['owner'], asksMore), key).toBe(true)
      }
    })

    it('needs owner and operator to pair a device with the Gateway', () => {
      const key = 'POST /api/system/approve-device'
      expect(decide(key, { access: access(['operator']) }).ok).toBe(false)
      expect(decide(key, { access: access(['owner']) }).ok).toBe(false)
      expect(decide(key, { access: access(['owner', 'operator']) }).ok).toBe(true)
    })
  })

  describe('setting up and running the workspace', () => {
    it("is the operator's, not the owner's", () => {
      for (const key of [
        'POST /api/agents',
        'POST /api/schedules',
        'POST /api/connectors/connect',
      ]) {
        expect(decide(key, { access: access(['operator']) }).ok, key).toBe(true)
        expect(decide(key, { access: access(['owner']) }).ok, key).toBe(false)
      }
      expect(decide('POST /api/providers/:id/connect', { access: access(['owner']) }).ok).toBe(
        false,
      )
      expect(decide('GET /api/cost-records', { access: access(['owner']) }).ok).toBe(false)
      expect(decide('GET /api/cost-records', { access: access(['operator']) }).ok).toBe(true)
    })

    it("lets the owner or an operator set a team's rules, but not a member", () => {
      const key = 'PUT /api/team-rules/:teamId'
      expect(decide(key, { access: access(['owner']), params: { teamId: 'T' } }).ok).toBe(true)
      expect(decide(key, { access: access(['operator']), params: { teamId: 'T' } }).ok).toBe(true)
      expect(decide(key, { access: access(['member']), params: { teamId: 'T' } }).ok).toBe(false)
    })

    it('needs the owner as well for a grant that never asks', () => {
      const key = 'POST /api/grants'
      const never = { approvalPolicy: 'never' }
      expect(
        decide(key, { access: access(['operator']), body: { approvalPolicy: 'risk' } }).ok,
      ).toBe(true)
      expect(decide(key, { access: access(['operator']), body: never }).ok).toBe(false)
      expect(decide(key, { access: access(['owner']), body: never }).ok).toBe(false)
      expect(decide(key, { access: access(['owner', 'operator']), body: never }).ok).toBe(true)
    })

    it('lets the owner take access away, and a member see the work but not the accounts', () => {
      expect(decide('POST /api/grants/:id/revoke', { access: access(['owner']) }).ok).toBe(true)
      expect(decide('GET /api/connectors', { access: access(['member']) }).ok).toBe(false)
      expect(decide('GET /api/board', { access: access(['member']) }).ok).toBe(true)
    })
  })

  describe('a service token', () => {
    const svc = access(['operator'], { service: true })

    it('does what its role allows, though it names no person', () => {
      expect(decide('GET /api/system/hold', { service: true, access: svc }).ok).toBe(true)
      expect(decide('POST /api/agents', { service: true, access: svc }).ok).toBe(true)
    })

    it('never answers an approval, even as an owner', () => {
      const asOwner = access(['owner'], { service: true })
      expect(
        decide('POST /api/tools/approvals/:id/resolve', {
          service: true,
          access: asOwner,
          body: { decision: 'allow_once' },
        }),
      ).toEqual({ ok: false, reason: 'not-allowed' })
    })
  })

  describe("a reader key's program", () => {
    const readerReads = READER_ROUTE_KEYS.filter((k) => k !== 'GET /api/system/live')

    it('reaches each of its reads, workspace-wide, with no role and no team scoping', () => {
      for (const key of readerReads) {
        expect(decide(key, { reader: 'reader:companion' }), key).toEqual({ ok: true, scope: null })
      }
    })

    it('reaches nothing else, not even the routes any person may use', () => {
      for (const key of [
        'GET /api/access/identity',
        'GET /api/system/capabilities',
        'GET /api/health',
        'GET /api/settings',
        'POST /api/teams',
        'GET /api/obs/errors',
        'POST /api/tools/approvals/:id/resolve',
        'POST /api/mcp/tasks',
      ]) {
        expect(decide(key, { reader: 'reader:companion' }), key).toEqual({
          ok: false,
          reason: 'reader',
        })
      }
    })

    it('gets the same 403 from the guard as from the identity lane', () => {
      expect(roleRefusalBody('reader')).toEqual(JSON.parse(readerRefusalBody()))
    })
  })

  describe('the liveness probe', () => {
    it('needs no person, service or reader', () => {
      expect(decide('GET /api/system/live', { person: false })).toEqual({ ok: true, scope: null })
      expect(decide('GET /api/system/live', { reader: 'reader:companion' }).ok).toBe(true)
    })
  })

  describe('a request with no role', () => {
    it('is refused, but may still ask who it is', () => {
      expect(decide('GET /api/board', { access: access([]) })).toEqual({
        ok: false,
        reason: 'no-role',
      })
      expect(decide('GET /api/board', { access: null })).toEqual({ ok: false, reason: 'no-role' })
      expect(decide('GET /api/access/identity', { access: access([]) }).ok).toBe(true)
    })

    it("with no person at all passes only on an MCP mount, the runtime's own call", () => {
      expect(decide('POST /api/mcp/tasks', { person: false }).ok).toBe(true)
      expect(decide('GET /api/board', { person: false })).toEqual({ ok: false, reason: 'person' })
      expect(decide('GET /api/mcp/config', { person: false }).ok).toBe(false)
    })
  })

  describe('a guest', () => {
    const guest = access(['guest'], { teams: ['T'], until: NOW / 1000 + 3600 })

    it('reaches their team by a team id, and no other', () => {
      const key = 'GET /api/teams/:id/rooms'
      expect(decide(key, { access: guest, params: { id: 'T' } })).toEqual({
        ok: true,
        scope: { teams: new Set(['T']) },
      })
      expect(decide(key, { access: guest, params: { id: 'OTHER' } })).toEqual({
        ok: false,
        reason: 'outside-teams',
      })
    })

    it('reaches an agent, a task and a question through their team', () => {
      expect(
        decide('POST /api/agents/:agentId/chat', { access: guest, params: { agentId: 'a1' } }).ok,
      ).toBe(true)
      expect(
        decide('POST /api/agents/:agentId/chat', { access: guest, params: { agentId: 'x1' } }).ok,
      ).toBe(false)
      expect(
        decide('GET /api/agents/:agentId', { access: guest, params: { agentId: 'none' } }).ok,
      ).toBe(false)
      expect(
        decide('PATCH /api/board/:taskId', { access: guest, params: { taskId: taskInT } }).ok,
      ).toBe(true)
      expect(
        decide('PATCH /api/board/:taskId', { access: guest, params: { taskId: taskInOther } }).ok,
      ).toBe(false)

      const now = Date.now()
      for (const [id, taskId] of [
        ['q-in', taskInT],
        ['q-out', taskInOther],
      ] as const) {
        db.insert(taskQuestions)
          .values({ id, taskId, kind: 'question', payload: '{}', createdAt: now, updatedAt: now })
          .run()
      }
      const key = 'POST /api/board/questions/:questionId/answer'
      expect(decide(key, { access: guest, params: { questionId: 'q-in' } }).ok).toBe(true)
      expect(decide(key, { access: guest, params: { questionId: 'q-out' } }).ok).toBe(false)
    })

    it('reaches a chat by its session key, a room by its team, and a new task by its body', () => {
      const teamKey = buildTeamSessionKey('a1', 'T')
      expect(
        decide('GET /api/chat-history', { access: guest, query: { sessionKey: teamKey } }).ok,
      ).toBe(true)
      expect(
        decide('GET /api/chat-history', {
          access: guest,
          query: { sessionKey: buildTeamSessionKey('x1', 'OTHER') },
        }).ok,
      ).toBe(false)
      // A one-to-one chat counts as the agent's team.
      expect(
        decide('GET /api/chat-history', { access: guest, query: { sessionKey: 'agent:a1:native' } })
          .ok,
      ).toBe(true)
      expect(
        decide('GET /api/chat-history', { access: guest, query: { sessionKey: 'agent:x1:native' } })
          .ok,
      ).toBe(false)

      const inT = createRoom(db, { teamId: 'T', name: 'Shoot', memberIds: ['a1'] })
      const inOther = createRoom(db, { teamId: 'OTHER', name: 'Ads', memberIds: ['x1'] })
      expect(decide('GET /api/team-chat', { access: guest, query: { roomId: inT.id } }).ok).toBe(
        true,
      )
      expect(
        decide('GET /api/team-chat', { access: guest, query: { roomId: inOther.id } }).ok,
      ).toBe(false)
      // A room of another team cannot ride on the guest's own team id.
      expect(
        decide('GET /api/team-chat', {
          access: guest,
          query: { teamId: 'T', roomId: inOther.id },
        }).ok,
      ).toBe(false)

      expect(
        decide('POST /api/board', { access: guest, body: { teamId: 'T', title: 'x' } }).ok,
      ).toBe(true)
      expect(decide('POST /api/board', { access: guest, body: { title: 'x' } }).ok).toBe(false)
    })

    it("keeps everything a guest's write names on their teams, not only the route's own team", () => {
      const create = (body: Record<string, unknown>) =>
        decide('POST /api/board', { access: guest, body: { teamId: 'T', title: 'x', ...body } }).ok
      // A task of their own team, hung under another team's task, would reopen it.
      expect(create({ parentTaskId: taskInOther })).toBe(false)
      expect(create({ parentTaskId: taskInT })).toBe(true)
      expect(create({ assigneeAgentId: 'x1' })).toBe(false)
      expect(create({ assigneeAgentId: 'a1' })).toBe(true)
      expect(create({ sourceDelegationId: 'assign:n:agent:a1:origin:human' })).toBe(false)

      const deps = (dependsOnTaskId: string) =>
        decide('POST /api/board/:taskId/deps', {
          access: guest,
          params: { taskId: taskInT },
          body: { dependsOnTaskId },
        }).ok
      expect(deps(taskInOther)).toBe(false)
      expect(deps(taskInT)).toBe(true)

      const assign = (agentId: string) =>
        decide('POST /api/board/:taskId/assign', {
          access: guest,
          params: { taskId: taskInT },
          body: { agentId },
        }).ok
      expect(assign('x1')).toBe(false)
      expect(assign(' a1 ')).toBe(false)
      expect(assign('a1')).toBe(true)
    })

    it('names only their own agents on a comment, and keeps out of the run ledger and worktrees', () => {
      const comment = (authorAgentId?: string) =>
        decide('POST /api/board/:taskId/comments', {
          access: guest,
          params: { taskId: taskInT },
          body: { body: 'Done', ...(authorAgentId ? { authorAgentId } : {}) },
        }).ok
      expect(comment()).toBe(true)
      expect(comment('a1')).toBe(true)
      expect(comment('x1')).toBe(false)
      expect(
        decide('POST /api/board/:taskId/executions', {
          access: guest,
          params: { taskId: taskInT },
          body: { executorType: 'native' },
        }).ok,
      ).toBe(false)
      expect(
        decide('POST /api/board/:taskId/workspace', {
          access: guest,
          params: { taskId: taskInT },
          body: { repoPath: '/somewhere/else' },
        }).ok,
      ).toBe(false)
    })

    it('refuses a cancel or a close that would carry along work of another team', () => {
      // A task of another team waits on the guest's task: cancelling it would cancel that one.
      linkDep(db, taskInOther, taskInT)
      expect(
        decide('POST /api/board/:taskId/cancel-dependents', {
          access: guest,
          params: { taskId: taskInT },
        }),
      ).toEqual({ ok: false, reason: 'outside-teams' })
      const move = (status: string) =>
        decide('PATCH /api/board/:taskId', {
          access: guest,
          params: { taskId: taskInT },
          body: { status },
        }).ok
      expect(move('cancelled')).toBe(false)
      expect(move('in_progress')).toBe(true)

      // A request whose open work sits on another team cannot be closed by a guest.
      const request = createTask(db, { title: 'Menu photos', teamId: 'T', mainTaskLead: 'a1' }).id
      createTask(db, { title: 'Ad copy', teamId: 'OTHER', parentTaskId: request })
      const close = (status: string) =>
        decide('PATCH /api/board/:taskId', {
          access: guest,
          params: { taskId: request },
          body: { status },
        }).ok
      expect(close('done')).toBe(false)
      expect(close('cancelled')).toBe(false)
    })

    it('lets a guest close a request when its work on another team is already finished', () => {
      // The close cancels only the open work under a request: finished work on another
      // team stays as it is, so it does not stand in the guest's way.
      const request = createTask(db, { title: 'Menu photos', teamId: 'T', mainTaskLead: 'a1' }).id
      const copy = createTask(db, { title: 'Ad copy', teamId: 'OTHER', parentTaskId: request }).id
      db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, copy)).run()
      for (const status of ['done', 'cancelled']) {
        expect(
          decide('PATCH /api/board/:taskId', {
            access: guest,
            params: { taskId: request },
            body: { status },
          }).ok,
          status,
        ).toBe(true)
      }
    })

    it("never reopens another team's closed request with a task made under it", () => {
      // A request on OTHER, closed, with work a hand-off filed on T under it.
      const request = createTask(db, { title: 'Campaign', teamId: 'OTHER', mainTaskLead: 'x1' }).id
      const handedOver = createTask(db, { title: 'Photos', teamId: 'T', parentTaskId: request }).id
      const make = () =>
        decide('POST /api/board', {
          access: guest,
          body: { title: 'Crop the photos', teamId: 'T', parentTaskId: handedOver },
        }).ok
      // While the request is open, nothing reopens: the guest may split their task.
      expect(make()).toBe(true)
      db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, request)).run()
      expect(make()).toBe(false)

      // Their own team's closed request they may reopen this way.
      const own = createTask(db, { title: 'Menu', teamId: 'T', mainTaskLead: 'a1' }).id
      const step = createTask(db, { title: 'Shoot', teamId: 'T', parentTaskId: own }).id
      db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, own)).run()
      expect(
        decide('POST /api/board', {
          access: guest,
          body: { title: 'Reshoot', teamId: 'T', parentTaskId: step },
        }).ok,
      ).toBe(true)
    })

    it('lets a guest cancel work whose dependents are all on their team', () => {
      const second = createTask(db, { title: 'Edit photos', teamId: 'T' }).id
      linkDep(db, second, taskInT)
      expect(
        decide('POST /api/board/:taskId/cancel-dependents', {
          access: guest,
          params: { taskId: taskInT },
        }).ok,
      ).toBe(true)
    })

    it('pauses only what is on their team', () => {
      expect(
        decide('POST /api/pauses', { access: guest, body: { kind: 'agent', id: 'a1' } }).ok,
      ).toBe(true)
      expect(
        decide('POST /api/pauses', { access: guest, body: { kind: 'team', id: 'OTHER' } }).ok,
      ).toBe(false)
      expect(
        decide('DELETE /api/pauses/:kind/:id', {
          access: guest,
          params: { kind: 'task', id: taskInT },
        }).ok,
      ).toBe(true)
      expect(decide('POST /api/pauses', { access: guest, body: { kind: 'all', id: 'x' } }).ok).toBe(
        false,
      )
    })

    it('retries, reopens or pauses a task only when its whole tree is on their teams', () => {
      // A main task on T, with work a hand-off filed on OTHER under it.
      const main = createTask(db, { title: 'Launch', teamId: 'T' }).id
      createTask(db, { title: 'Ads copy', teamId: 'OTHER', parentTaskId: main })

      // A retry or a reopen can move the main task above and the work under it.
      // (A cancel or a close is checked by what it carries along: see above.)
      for (const key of ['POST /api/board/:taskId/retry', 'POST /api/board/:taskId/reopen']) {
        const as = (who: PersonAccess, taskId: string) =>
          decide(key, { access: who, params: { taskId } }).ok
        expect(as(guest, main), key).toBe(false)
        expect(as(guest, taskInT), key).toBe(true)
        // With both teams in the token, all of it is theirs.
        const both = access(['guest'], { teams: ['T', 'OTHER'], until: NOW / 1000 + 3600 })
        expect(as(both, main), key).toBe(true)
      }
      // A pause covers the whole tree, from any task in it.
      expect(
        decide('POST /api/pauses', { access: guest, body: { kind: 'task', id: main } }).ok,
      ).toBe(false)
      expect(
        decide('DELETE /api/pauses/:kind/:id', {
          access: guest,
          params: { kind: 'task', id: main },
        }).ok,
      ).toBe(false)
      // What stays on the task itself still reaches it.
      expect(
        decide('POST /api/board/:taskId/comments', {
          access: guest,
          params: { taskId: main },
          body: { content: 'Looks good' },
        }).ok,
      ).toBe(true)
      expect(decide('GET /api/board/:taskId', { access: guest, params: { taskId: main } }).ok).toBe(
        true,
      )
    })

    it('reads a pause from where its handler does, so a body cannot point the guard elsewhere', () => {
      // The resume acts on the path's pause: a body naming the guest's own team
      // must not carry it past the guard.
      expect(
        decide('DELETE /api/pauses/:kind/:id', {
          access: guest,
          params: { kind: 'team', id: 'OTHER' },
          body: { kind: 'team', id: 'T' },
        }).ok,
      ).toBe(false)
      // And a new pause is the body's, whatever the path says.
      expect(
        decide('POST /api/pauses', {
          access: guest,
          params: { kind: 'team', id: 'T' },
          body: { kind: 'team', id: 'OTHER' },
        }).ok,
      ).toBe(false)
    })

    it("changes a room only when it is on the team in the path, and that team is the guest's", () => {
      const inT = createRoom(db, { teamId: 'T', name: 'Shoot', memberIds: ['a1'] })
      const inOther = createRoom(db, { teamId: 'OTHER', name: 'Ads', memberIds: ['x1'] })
      const patch = (id: string, roomId: string) =>
        decide('PATCH /api/teams/:id/rooms/:roomId', {
          access: guest,
          params: { id, roomId },
          body: { name: 'x' },
        }).ok
      expect(patch('T', inT.id)).toBe(true)
      expect(patch('T', inOther.id)).toBe(false)
      expect(patch('OTHER', inOther.id)).toBe(false)
    })

    it('gets the lists cut down by their handlers, and nothing a route does not open to guests', () => {
      expect(decide('GET /api/board', { access: guest })).toEqual({
        ok: true,
        scope: { teams: new Set(['T']) },
      })
      expect(decide('GET /api/memory', { access: guest })).toEqual({
        ok: false,
        reason: 'outside-teams',
      })
      expect(decide('GET /api/board/inbox', { access: guest }).ok).toBe(false)
    })

    it('is refused everything once their access ends, but may still ask who they are', () => {
      const ended = access(['guest'], { teams: ['T'], until: NOW / 1000 })
      expect(decide('GET /api/teams/:id/rooms', { access: ended, params: { id: 'T' } })).toEqual({
        ok: false,
        reason: 'ended',
      })
      expect(decide('GET /api/access/identity', { access: ended }).ok).toBe(true)
    })

    it('reaches no team when the token names none', () => {
      const none = access(['guest'])
      expect(decide('GET /api/teams/:id/rooms', { access: none, params: { id: 'T' } }).ok).toBe(
        false,
      )
    })

    it('loses the limits when another role comes with it', () => {
      const both = access(['member', 'guest'], { teams: ['T'] })
      expect(decide('GET /api/memory', { access: both })).toEqual({ ok: true, scope: null })
    })
  })
})

describe('roleGuard', () => {
  function run(mode: 'off' | 'enforce', ruleToUse: RouteRule, accessToUse: PersonAccess | null) {
    const req = {
      params: {},
      query: {},
      body: {},
      person: { id: 'p-1', name: null, role: null },
      access: accessToUse,
      app: { locals: { rolesMode: mode } },
    } as unknown as Request
    let status = 200
    let body: unknown
    const heard: Record<string, () => void> = {}
    const destroy = vi.fn()
    const res = {
      writableEnded: false,
      status(code: number) {
        status = code
        return this
      },
      set() {
        return this
      },
      json(b: unknown) {
        body = b
        return this
      },
      on(event: string, fn: () => void) {
        heard[event] = fn
        return this
      },
      destroy,
    } as unknown as Response
    const next = vi.fn() as unknown as NextFunction
    roleGuard(ruleToUse)(req, res, next)
    return { req, status, body, next: next as unknown as ReturnType<typeof vi.fn>, heard, destroy }
  }

  describe("a guest's open stream", () => {
    afterEach(() => vi.useRealTimers())

    it('is closed when their access ends', () => {
      vi.useFakeTimers()
      const until = Date.now() / 1000 + 2
      const out = run(
        'enforce',
        { need: 'see', guest: { by: 'any' } },
        access(['guest'], { teams: ['T'], until }),
      )
      expect(out.next).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(1_999)
      expect(out.destroy).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(out.destroy).toHaveBeenCalledOnce()
    })

    it('is left alone once the response has finished, and for anyone but a guest', () => {
      vi.useFakeTimers()
      const until = Date.now() / 1000 + 2
      const done = run(
        'enforce',
        { need: 'see', guest: { by: 'any' } },
        access(['guest'], { teams: ['T'], until }),
      )
      done.heard['finish']?.()
      const member = run('enforce', { need: 'see' }, access(['member'], { until }))
      vi.advanceTimersByTime(5_000)
      expect(done.destroy).not.toHaveBeenCalled()
      expect(member.destroy).not.toHaveBeenCalled()
    })
  })

  it('passes every request through while roles are off', () => {
    const out = run('off', { need: 'system' }, null)
    expect(out.next).toHaveBeenCalledOnce()
  })

  it('refuses with a 403 that says why, and never calls the route', () => {
    const out = run('enforce', { need: 'system' }, access(['member']))
    expect(out.next).not.toHaveBeenCalled()
    expect(out.status).toBe(403)
    expect(out.body).toEqual(roleRefusalBody('not-allowed'))
    expect(out.body).toMatchObject({ error: 'role', reason: 'not-allowed' })
  })

  it("hands a guest's teams to the handler", () => {
    const out = run(
      'enforce',
      { need: 'see', guest: { by: 'list' } },
      access(['guest'], { teams: ['T'], until: Date.now() / 1000 + 3600 }),
    )
    expect(out.next).toHaveBeenCalledOnce()
    expect(inRoleScope(out.req, 'T')).toBe(true)
    expect(inRoleScope(out.req, 'OTHER')).toBe(false)
    expect(inRoleScope(out.req, null)).toBe(false)
  })

  it('shows everything to everyone the guest limits do not hold for', () => {
    const out = run('enforce', { need: 'see' }, access(['member']))
    expect(inRoleScope(out.req, 'OTHER')).toBe(true)
    expect(inRoleScope(out.req, null)).toBe(true)
  })
})

describe('upgradeAllowedForRoles', () => {
  const person = { id: 'p-1', name: null, role: null }

  it('opens the Gateway socket for anyone while roles are off', () => {
    expect(upgradeAllowedForRoles('off', { person: null })).toBe(true)
  })

  it('opens it only for a person who runs the system and answers approvals, standing ones too', () => {
    // OpenClaw's approvals, "Allow always" among them, travel on the socket unchecked.
    expect(upgradeAllowedForRoles('enforce', { person, access: access(['operator']) })).toBe(false)
    expect(upgradeAllowedForRoles('enforce', { person, access: access(['owner']) })).toBe(false)
    expect(
      upgradeAllowedForRoles('enforce', { person, access: access(['owner', 'operator']) }),
    ).toBe(true)
    expect(upgradeAllowedForRoles('enforce', { person, access: null })).toBe(false)
    expect(upgradeAllowedForRoles('enforce', { person: null, access: access(['operator']) })).toBe(
      false,
    )
  })
})

describe('a service token and the person check', () => {
  it('never acts as a person, whatever headers it sends', async () => {
    const { actsAsPerson } = await import('../../auth')
    const headers = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
    const asService = {
      headers,
      person: null,
      service: { id: 'svc-1', name: null, role: 'operator' },
    } as unknown as Request
    expect(actsAsPerson(asService)).toBe(false)
    const asDashboard = { headers, person: null } as unknown as Request
    expect(actsAsPerson(asDashboard)).toBe(true)
  })
})
