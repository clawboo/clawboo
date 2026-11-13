// A Hermes run through the supervised gateway, against a stand-in gateway that
// speaks the v0.23.1 API server's wire shapes (bearer key per profile, run
// events as SSE frames whose name is the JSON `event` field, approval answers
// with `request_id` and `execution_generation`).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createDb, toolCallApprovals, type ClawbooDb } from '@clawboo/db'
import type { HermesNativeEvent } from '@clawboo/adapter-hermes'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearLiveRunBindings, liveRunScope } from '../../../mcpLiveBindings'
import type { RuntimeRunContext } from '../../types'
import { clearPendingHermesApprovals, resolveHermesApproval } from '../approvals'
import { createHermesClient } from '../client'
import type { HermesGatewaySupervisor } from '../gateway'
import { createHermesGatewayDriver, type HermesGatewayDriverDeps } from '../gatewayDriver'
import { derivedHermesKey } from '../profiles'

const MASTER = 'm'.repeat(64)

type Frame = Record<string, unknown>

interface FakeGateway {
  url: string
  runs: { profile: string; body: Record<string, unknown> }[]
  approvals: Record<string, unknown>[]
  steers: string[]
  stops: number
  /** Events to send for the next run; a function step waits for something. */
  script: (Frame | (() => Promise<void>))[]
  /** Push more events to the open stream. */
  emit: (f: Frame) => void
  steerStatus: number
  /** A session id POST /v1/runs refuses with 409, as one another surface owns. */
  refuseSession: string | null
  /** Whether a stop ends the run at once (Hermes stops between steps). */
  stopCancels: boolean
  /** What GET /v1/runs/run_1 answers. */
  status: Frame
  /** The events stream closes at once, with nothing on it. */
  dropStream: boolean
  /** The Idempotency-Key of each POST /v1/runs. */
  startKeys: (string | undefined)[]
  /** The first start is taken, but its answer is lost. */
  loseFirstStart: boolean
  /** Hermes reports the card settled before it replies to the answer. */
  settleBeforeReply: boolean
  /** Starts refused as a profile the gateway does not serve yet. */
  unservedStarts: number
  close: () => Promise<void>
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const c of req) raw += c
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

async function fakeGateway(): Promise<FakeGateway> {
  let stream: ServerResponse | null = null
  let seq = 0
  const g: FakeGateway = {
    url: '',
    runs: [],
    approvals: [],
    steers: [],
    stops: 0,
    script: [],
    steerStatus: 200,
    refuseSession: null,
    stopCancels: true,
    status: { run_id: 'run_1', status: 'running' },
    dropStream: false,
    startKeys: [],
    loseFirstStart: false,
    settleBeforeReply: false,
    unservedStarts: 0,
    emit: (f) => {
      stream?.write(`id: ${seq}\ndata: ${JSON.stringify({ ...f, seq: seq++ })}\n\n`)
      if (typeof f['event'] === 'string' && /^run\.(completed|failed|cancelled)/.test(f['event'])) {
        stream?.end(': stream closed\n\n')
        stream = null
      }
    },
    close: async () => undefined,
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      const m = /^\/p\/([^/]+)(\/.*)$/.exec(url)
      const profile = m?.[1] ?? null
      const route = m?.[2] ?? url
      if (route === '/health') {
        res.end(JSON.stringify({ status: 'ok', version: '0.23.1' }))
        return
      }
      const want = `Bearer ${derivedHermesKey(MASTER, profile ?? '_root')}`
      if (req.headers.authorization !== want) {
        res.statusCode = 401
        res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }))
        return
      }
      if (route.startsWith('/api/jobs')) {
        res.end(JSON.stringify({ jobs: [] }))
        return
      }
      if (req.method === 'POST' && route === '/v1/runs') {
        const b = await body(req)
        const key = req.headers['idempotency-key'] as string | undefined
        if (g.unservedStarts > 0) {
          // A refused start leaves no run and forgets its key, as Hermes does.
          g.unservedStarts -= 1
          res.statusCode = 409
          res.end(
            JSON.stringify({
              error: { message: 'profile_mismatch', type: 'invalid_request_error', code: null },
            }),
          )
          return
        }
        const replay = key !== undefined && g.startKeys.includes(key)
        g.startKeys.push(key)
        if (replay) {
          res.statusCode = 202
          res.end(JSON.stringify({ run_id: 'run_1', status: 'running', replayed: true }))
          return
        }
        if (g.loseFirstStart && g.startKeys.length === 1) {
          g.runs.push({ profile: profile ?? '', body: b })
          req.socket.destroy()
          return
        }
        if (g.refuseSession && b['session_id'] === g.refuseSession) {
          res.statusCode = 409
          res.end(
            JSON.stringify({ error: { message: 'permission_denied', code: 'permission_denied' } }),
          )
          return
        }
        g.runs.push({ profile: profile ?? '', body: b })
        res.statusCode = 202
        res.end(JSON.stringify({ run_id: 'run_1', status: 'started' }))
        return
      }
      if (req.method === 'GET' && route === '/v1/runs/run_1') {
        res.end(JSON.stringify(g.status))
        return
      }
      if (route === '/v1/runs/run_1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': open\n\n')
        if (g.dropStream) {
          res.end()
          return
        }
        stream = res
        for (const step of g.script) {
          if (typeof step === 'function') await step()
          else g.emit(step)
        }
        return
      }
      if (req.method === 'POST' && route === '/v1/runs/run_1/approval') {
        const answer = await body(req)
        g.approvals.push(answer)
        if (g.settleBeforeReply) {
          g.emit({ event: 'approval.settled', prompt_id: answer['request_id'] })
          await new Promise((r) => setTimeout(r, 150))
        }
        res.end(JSON.stringify({ status: 'resolved' }))
        return
      }
      if (req.method === 'POST' && route === '/v1/runs/run_1/steer') {
        const b = await body(req)
        res.statusCode = g.steerStatus
        if (g.steerStatus === 200) g.steers.push(String(b['input']))
        res.end(JSON.stringify(g.steerStatus === 200 ? { status: 'accepted' } : { error: 'no' }))
        return
      }
      if (req.method === 'POST' && route === '/v1/runs/run_1/stop') {
        g.stops += 1
        res.end(JSON.stringify({ status: 'stopping' }))
        if (g.stopCancels) g.emit({ event: 'run.cancelled', run_id: 'run_1' })
        return
      }
      res.statusCode = 404
      res.end('{}')
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  g.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  g.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections()
      server.close(() => r())
    })
  return g
}

function supervisorFor(g: FakeGateway, home: string): HermesGatewaySupervisor {
  const conn = { baseUrl: g.url, home, masterKey: MASTER, port: 0 }
  return {
    ensureRunning: async () => conn,
    status: () => ({ pid: 1 }),
    profileClient: (_c: unknown, profile: string) =>
      createHermesClient({ baseUrl: g.url, profile, key: derivedHermesKey(MASTER, profile) }),
  } as unknown as HermesGatewaySupervisor
}

const until = async (cond: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('createHermesGatewayDriver', () => {
  let root: string
  let g: FakeGateway
  let db: ClawbooDb
  let prevHome: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-driver-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = path.join(root, 'home')
    delete process.env['HERMES_HOME']
    g = await fakeGateway()
    db = createDb(':memory:')
    clearLiveRunBindings()
    clearPendingHermesApprovals()
  })
  afterEach(async () => {
    process.env['HOME'] = prevHome
    await g.close()
    await rm(root, { recursive: true, force: true })
  })

  const ctx = (over: Partial<RuntimeRunContext> = {}): RuntimeRunContext => ({
    homeDir: path.join(root, 'legacy', 'agent-1'),
    cwd: path.join(root, 'work'),
    mcpBaseUrl: 'http://127.0.0.1:18790',
    apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' },
    memoryScope: {
      agentId: 'agent-1',
      teamId: 'team-1',
      boundTaskId: 'task-1',
      attachSecret: 's'.repeat(64),
    },
    ...over,
  })

  function drive(
    c: RuntimeRunContext,
    message = 'do the task',
    extra: Partial<HermesGatewayDriverDeps> = {},
  ) {
    const events: HermesNativeEvent[] = []
    const driver = createHermesGatewayDriver({ agentId: 'agent-1', sessionKey: 'sk', message }, c, {
      supervisor: supervisorFor(g, path.join(root, 'gw')),
      db: () => db,
      profileReadyMs: 2_000,
      ...extra,
    })
    driver.onEvent((ev) => events.push(ev))
    const result = () => events.find((e) => e.type === 'result')
    return { driver, events, result }
  }

  it("streams a run in the agent's own profile and reports its tokens", async () => {
    g.script = [
      { event: 'tool.started', tool: 'terminal', preview: 'ls', tool_call_id: 'call_1' },
      { event: 'tool.completed', tool: 'terminal', error: false, tool_call_id: 'call_1' },
      { event: 'message.delta', delta: 'All ' },
      { event: 'message.delta', delta: 'done.' },
      {
        event: 'run.completed',
        output: 'All done.',
        usage: { input_tokens: 120, output_tokens: 12, total_tokens: 132 },
      },
    ]
    const { driver, events, result } = drive(ctx())
    await driver.start()
    // The run binds the agent's live MCP calls while it lasts.
    expect(liveRunScope('agent-1')).toMatchObject({ boundTaskId: 'task-1', teamId: 'team-1' })
    await until(() => Boolean(result()))

    expect(g.runs).toHaveLength(1)
    expect(g.runs[0]!.profile).toBe('cb-agent-1')
    expect(g.runs[0]!.body).toMatchObject({
      input: 'do the task',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
    })
    expect(String(g.runs[0]!.body['session_id'])).toMatch(/^cb-/)
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'tool-call',
      'tool-result',
      'message',
      'message',
      'result',
    ])
    expect(result()).toMatchObject({
      ok: true,
      summary: 'All done.',
      usage: { inputTokens: 120, outputTokens: 12 },
      model: 'openai/gpt-4o-mini',
    })
    expect(liveRunScope('agent-1')).toBeNull()

    // The working folder rode the profile's .env, as the API has none per run.
    const env = await readFile(path.join(root, 'gw', 'profiles', 'cb-agent-1', '.env'), 'utf8')
    expect(env).toContain(`TERMINAL_CWD="${path.join(root, 'work')}"`)
    const config = await readFile(
      path.join(root, 'gw', 'profiles', 'cb-agent-1', 'config.yaml'),
      'utf8',
    )
    // One live URL per server for the agent, not this run's scope.
    expect(config).toContain('live=1')
    expect(config).not.toContain('scopeTaskId')
  })

  it("turns Hermes's approval request into a card and answers it back", async () => {
    let answered: () => void = () => undefined
    const gotAnswer = new Promise<void>((r) => (answered = r))
    g.script = [
      {
        event: 'approval.request',
        prompt_id: 'p1',
        execution_generation: 1,
        command: 'rm -rf build',
        description: 'recursive delete',
        choices: ['once', 'session', 'always', 'deny'],
        timeout_s: 120,
      },
      () => gotAnswer,
      { event: 'approval.settled', prompt_id: 'p1', choice: 'once' },
      { event: 'run.completed', output: 'ok', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { driver, result } = drive(ctx())
    await driver.start()
    await until(() => db.select().from(toolCallApprovals).all().length > 0)
    const [card] = db.select().from(toolCallApprovals).all()
    expect(card).toMatchObject({
      id: 'hermes:run_1:p1',
      kind: 'hermes',
      toolName: 'run_command',
      status: 'pending',
      agentId: 'agent-1',
      taskId: 'task-1',
      neverRemember: 1,
    })
    expect(JSON.parse(card!.argsSummary!)).toMatchObject({ command: 'rm -rf build' })
    // The card's deadline is Hermes's own wait for this request.
    expect(card!.expiresAt - card!.createdAt).toBe(120_000)

    const out = await resolveHermesApproval(db, card!.id, 'allow_once')
    expect(out.status).toBe(200)
    expect(g.approvals).toEqual([{ request_id: 'p1', execution_generation: 1, choice: 'once' }])
    answered()
    await until(() => Boolean(result()))
    expect(db.select().from(toolCallApprovals).all()[0]!.status).toBe('allow_once')
  })

  it('a failed run carries the provider cause read from its error', async () => {
    g.script = [
      {
        event: 'run.failed',
        error:
          "Error code: 401 - {'error': {'message': 'Incorrect API key provided', 'type': 'invalid_request_error', 'code': 'invalid_api_key'}}",
      },
    ]
    const { driver, result } = drive(ctx())
    await driver.start()
    await until(() => Boolean(result()))
    expect(result()).toMatchObject({ ok: false, errorCode: 'invalid_api_key' })
  })

  it('steers live; an FYI rides only into an open tool batch', async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((r) => (release = r))
    g.script = [
      { event: 'message.delta', delta: 'thinking' },
      () => hold,
      { event: 'tool.started', tool: 'terminal', preview: 'make', tool_call_id: 'c1' },
      () => hold,
      { event: 'run.completed', output: 'ok' },
    ]
    const { driver, events, result } = drive(ctx())
    await driver.start()
    await until(() => events.some((e) => e.type === 'message'))
    expect(driver.steering?.()).toBe('live')
    expect(await driver.steer!('use the other branch')).toBe(true)
    expect(await driver.steer!('fyi', { passive: true })).toBe(false)
    expect(g.steers).toEqual(['use the other branch'])
    g.steerStatus = 409
    expect(await driver.steer!('too late')).toBe(false)
    release()
    await until(() => Boolean(result()))
  })

  it('a stop asks the gateway to stop the run and ends aborted', async () => {
    g.script = [{ event: 'message.delta', delta: 'working' }, () => new Promise(() => undefined)]
    const { driver, events, result } = drive(ctx())
    await driver.start()
    await until(() => events.some((e) => e.type === 'message'))
    await driver.abort()
    await until(() => Boolean(result()))
    expect(g.stops).toBe(1)
    expect(result()).toMatchObject({ ok: true, aborted: true })
  })

  it('resumes a session only in the folder it was last run in', async () => {
    const done = { event: 'run.completed', output: 'ok' }
    g.script = [done]
    const first = drive(ctx())
    await first.driver.start()
    await until(() => Boolean(first.result()))
    const session = String(g.runs[0]!.body['session_id'])

    const same = drive(ctx({ resume: session }))
    await same.driver.start()
    await until(() => Boolean(same.result()))
    expect(g.runs[1]!.body['session_id']).toBe(session)

    const moved = drive(ctx({ resume: session, cwd: path.join(root, 'other') }))
    await moved.driver.start()
    await until(() => Boolean(moved.result()))
    expect(g.runs[2]!.body['session_id']).not.toBe(session)
  })

  it('starts a new session when Hermes refuses to continue the old one', async () => {
    g.script = [{ event: 'run.completed', output: 'ok' }]
    // An agent from an earlier Clawboo, whose home moves into its profile, with a
    // session that Clawboo made over Hermes's editor protocol.
    await mkdir(path.join(root, 'legacy', 'agent-1', 'memories'), { recursive: true })
    await writeFile(path.join(root, 'legacy', 'agent-1', 'memories', 'MEMORY.md'), 'x')
    g.refuseSession = 'acp-session-1'
    const { driver, events, result } = drive(ctx({ resume: 'acp-session-1' }))
    await driver.start()
    await until(() => Boolean(result()))
    expect(result()).toMatchObject({ ok: true })
    expect(String(g.runs[0]!.body['session_id'])).toMatch(/^cb-/)
    expect(result()).toMatchObject({ sessionId: g.runs[0]!.body['session_id'] })
    expect(events.filter((e) => e.type === 'session')).toHaveLength(2)
  })

  it('a run with no identity home gets a throwaway profile with its own URLs, removed after', async () => {
    g.script = [{ event: 'run.completed', output: 'ok' }]
    const { driver, result } = drive(ctx({ homeDir: null }))
    await driver.start()
    await until(() => Boolean(result()))
    const profile = g.runs[0]!.profile
    expect(profile).toMatch(/^cbtmp-[0-9a-f]{16}$/)
    expect(liveRunScope('agent-1')).toBeNull()
    await until(() => !existsSync(path.join(root, 'gw', 'profiles', profile)))
  })

  it("runs one agent's runs one at a time, whoever starts them", async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((r) => (release = r))
    g.script = [
      { event: 'message.delta', delta: 'first' },
      () => hold,
      { event: 'run.completed', output: 'ok' },
    ]
    const first = drive(ctx())
    const second = drive(ctx({ cwd: path.join(root, 'other') }))
    await first.driver.start()
    const secondStarted = second.driver.start()
    await until(() => first.events.some((e) => e.type === 'message'))
    // The second run waits for the first to end before it touches the profile.
    await new Promise((r) => setTimeout(r, 150))
    expect(g.runs).toHaveLength(1)
    const env = await readFile(path.join(root, 'gw', 'profiles', 'cb-agent-1', '.env'), 'utf8')
    expect(env).toContain(`TERMINAL_CWD="${path.join(root, 'work')}"`)
    g.script = [{ event: 'run.completed', output: 'second' }]
    release()
    await until(() => Boolean(first.result()))
    await secondStarted
    await until(() => Boolean(second.result()))
    expect(g.runs).toHaveLength(2)
    expect(second.result()).toMatchObject({ ok: true, summary: 'second' })
  })

  it('a stopped run keeps its agent until Hermes says the run ended', async () => {
    g.stopCancels = false
    g.script = [{ event: 'message.delta', delta: 'working' }, () => new Promise(() => undefined)]
    const first = drive(ctx(), 'one', { stopGraceMs: 30, pollMs: 20 })
    await first.driver.start()
    await until(() => first.events.some((e) => e.type === 'message'))
    await first.driver.abort()
    await until(() => Boolean(first.result()))
    expect(first.result()).toMatchObject({ ok: true, aborted: true })
    // Hermes is still finishing it: the agent's next run waits, and the folder
    // in the profile is still the stopped run's.
    g.script = [{ event: 'run.completed', output: 'next' }]
    const second = drive(ctx({ cwd: path.join(root, 'other') }), 'two', { pollMs: 20 })
    const secondStarted = second.driver.start()
    await new Promise((r) => setTimeout(r, 200))
    expect(g.runs).toHaveLength(1)
    const env = await readFile(path.join(root, 'gw', 'profiles', 'cb-agent-1', '.env'), 'utf8')
    expect(env).toContain(`TERMINAL_CWD="${path.join(root, 'work')}"`)
    // It was asked once more to stop.
    expect(g.stops).toBeGreaterThanOrEqual(2)
    g.status = { run_id: 'run_1', status: 'cancelled' }
    await secondStarted
    await until(() => Boolean(second.result()))
    expect(g.runs).toHaveLength(2)
    expect(second.result()).toMatchObject({ ok: true, summary: 'next' })
  })

  it("a run waiting behind its agent's previous run can be stopped while it waits", async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((r) => (release = r))
    g.script = [
      { event: 'message.delta', delta: 'first' },
      () => hold,
      { event: 'run.completed', output: 'ok' },
    ]
    const first = drive(ctx())
    await first.driver.start()
    await until(() => first.events.some((e) => e.type === 'message'))
    const second = drive(ctx({ cwd: path.join(root, 'other') }))
    const started = second.driver.start()
    await new Promise((r) => setTimeout(r, 50))
    await second.driver.abort()
    await started
    expect(second.result()).toMatchObject({ ok: true, aborted: true })
    expect(g.runs).toHaveLength(1)
    release()
    await until(() => Boolean(first.result()))
  })

  it('reads a run by polling when its stream keeps closing, its approvals included', async () => {
    g.dropStream = true
    g.status = {
      run_id: 'run_1',
      status: 'waiting_for_approval',
      approval: {
        event: 'approval.request',
        prompt_id: 'p9',
        execution_generation: 2,
        command: 'rm -rf dist',
        timeout_s: 60,
      },
    }
    const { driver, result } = drive(ctx(), 'x', { pollMs: 20 })
    await driver.start()
    await until(() => db.select().from(toolCallApprovals).all().length > 0)
    expect(db.select().from(toolCallApprovals).all()[0]).toMatchObject({
      id: 'hermes:run_1:p9',
      status: 'pending',
    })
    g.status = {
      run_id: 'run_1',
      status: 'failed',
      error:
        "Error code: 401 - {'error': {'message': 'Incorrect API key provided', 'code': 'invalid_api_key'}}",
    }
    await until(() => Boolean(result()))
    expect(result()).toMatchObject({ ok: false, errorCode: 'invalid_api_key' })
    expect(db.select().from(toolCallApprovals).all()[0]!.status).not.toBe('pending')
  })

  it('asks again with the same key when the answer to a start is lost', async () => {
    g.loseFirstStart = true
    g.script = [{ event: 'run.completed', output: 'ok' }]
    const { driver, result } = drive(ctx())
    await driver.start()
    await until(() => Boolean(result()))
    expect(result()).toMatchObject({ ok: true, summary: 'ok' })
    expect(g.startKeys).toHaveLength(2)
    expect(g.startKeys[0]).toBeTruthy()
    expect(g.startKeys[1]).toBe(g.startKeys[0])
    // One run on Hermes's side: the second ask named the first.
    expect(g.runs).toHaveLength(1)
  })

  it('remembers where a session last ran across a restart, in the profile', async () => {
    g.script = [{ event: 'run.completed', output: 'ok' }]
    const first = drive(ctx())
    await first.driver.start()
    await until(() => Boolean(first.result()))
    const session = String(g.runs[0]!.body['session_id'])
    const file = path.join(root, 'gw', 'profiles', 'cb-agent-1', '.clawboo-sessions.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [session]: path.join(root, 'work') })
    // Last run elsewhere, as a restarted server reads it from the profile alone.
    await writeFile(file, JSON.stringify({ [session]: path.join(root, 'other') }))
    const again = drive(ctx({ resume: session }))
    await again.driver.start()
    await until(() => Boolean(again.result()))
    expect(g.runs[1]!.body['session_id']).not.toBe(session)
  })

  it("keeps the person's decision when Hermes reports a card settled before it replies", async () => {
    g.settleBeforeReply = true
    let answered: () => void = () => undefined
    const gotAnswer = new Promise<void>((r) => (answered = r))
    g.script = [
      {
        event: 'approval.request',
        prompt_id: 'p1',
        execution_generation: 1,
        command: 'rm -rf build',
        choices: ['once', 'deny'],
      },
      () => gotAnswer,
      { event: 'run.completed', output: 'ok' },
    ]
    const { driver, result } = drive(ctx())
    await driver.start()
    await until(() => db.select().from(toolCallApprovals).all().length > 0)
    const id = db.select().from(toolCallApprovals).all()[0]!.id
    const first = resolveHermesApproval(db, id, 'deny')
    await until(() => g.approvals.length === 1)
    // A second answer while the first is on its way is refused, not raced.
    expect((await resolveHermesApproval(db, id, 'allow_once')).status).toBe(409)
    expect((await first).status).toBe(200)
    expect(g.approvals).toHaveLength(1)
    expect(db.select().from(toolCallApprovals).all()[0]!.status).toBe('deny')
    answered()
    await until(() => Boolean(result()))
  })

  it('waits for the gateway to serve a profile written since its last scan', async () => {
    g.unservedStarts = 2
    g.script = [{ event: 'run.completed', output: 'served' }]
    const { driver, result } = drive(ctx())
    await driver.start()
    await until(() => Boolean(result()))
    expect(result()).toMatchObject({ ok: true, summary: 'served' })
    expect(g.runs).toHaveLength(1)
  })

  it('says so when the gateway never serves the profile', async () => {
    g.unservedStarts = 1_000
    const { driver, result } = drive(ctx(), 'x', { profileReadyMs: 1_500 })
    await driver.start()
    await until(() => Boolean(result()), 8_000)
    expect(result()).toMatchObject({
      ok: false,
      errorMessage: expect.stringContaining('did not pick up'),
    })
    expect(g.runs).toHaveLength(0)
  })

  it('a gateway that cannot start fails the run with its reason', async () => {
    const driver = createHermesGatewayDriver(
      { agentId: 'agent-1', sessionKey: 'sk', message: 'x' },
      ctx(),
      {
        supervisor: {
          ensureRunning: async () => {
            throw new Error(
              'Hermes is not installed by Clawboo. Install it from Settings > Runtimes.',
            )
          },
        } as unknown as HermesGatewaySupervisor,
        db: () => db,
      },
    )
    const events: HermesNativeEvent[] = []
    driver.onEvent((e) => events.push(e))
    await mkdir(path.join(root, 'work'), { recursive: true })
    await driver.start()
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      ok: false,
      errorMessage: expect.stringContaining('not installed by Clawboo'),
    })
  })
})
