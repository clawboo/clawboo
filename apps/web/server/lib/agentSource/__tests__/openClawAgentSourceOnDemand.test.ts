// The server connects to the OpenClaw Gateway only once something needs it, so a
// Gateway that a service manager starts on its first connection stays asleep on
// an install that does not use OpenClaw. These tests pin each way in (an OpenClaw
// agent, `markInUse`, an explicit reconnect), what the source reports until then
// ("not in use", not "unreachable"), and that an install with OpenClaw agents
// still connects at start as it always did.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, setSetting } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../db'
import {
  hasLiveOpenClawAgent,
  hasStandingGatewayNeed,
  OpenClawAgentSource,
  type OpenClawAgentSourceDeps,
  type OpenClawClientLike,
} from '../openClawAgentSource'

/** A Gateway client that counts connects. `connectWith` decides how each ends. */
class CountingGateway implements OpenClawClientLike {
  connects = 0
  connectWith: () => Promise<void> = () => Promise.resolve()
  list = { defaultId: 'main', mainKey: 'main', agents: [{ id: 'main', name: 'Main' }] }

  connect(): Promise<void> {
    this.connects += 1
    return this.connectWith()
  }
  disconnect(): void {}
  onStatus(): () => void {
    return () => {}
  }
  onEvent(): () => void {
    return () => {}
  }
  call<T = unknown>(): Promise<T> {
    return Promise.resolve(undefined as T)
  }
  agents = {
    list: () => Promise.resolve(this.list),
    create: () => Promise.resolve({ agentId: 'x' }),
    delete: () => Promise.resolve(),
    files: { read: () => Promise.resolve(''), set: () => Promise.resolve() },
  }
  sessions = { list: () => Promise.resolve([]) }
  config = { get: () => Promise.resolve({}), patch: () => Promise.resolve() }
}

function makeSource(
  fake: CountingGateway,
  deps: Partial<OpenClawAgentSourceDeps> = {},
): OpenClawAgentSource {
  return new OpenClawAgentSource({
    getDb,
    loadSettings: () => ({ gatewayUrl: 'ws://test:18789', gatewayToken: 'tok' }),
    makeClient: () => fake,
    connectOptions: () => ({}),
    // What the registry wires: an OpenClaw agent that is not archived.
    hasStandingNeed: () => hasLiveOpenClawAgent(getDb()),
    ...deps,
  })
}

function insertAgent(id: string, sourceId: string, archivedAt: number | null = null): void {
  const now = Date.now()
  getDb()
    .insert(agents)
    .values({
      id,
      name: id,
      gatewayId: id,
      sourceId,
      runtime: sourceId,
      status: 'idle',
      archivedAt,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

/** Let a connect started without an await (markInUse) run to its sync. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

describe('OpenClawAgentSource on demand', () => {
  let home: string
  let prevHome: string | undefined
  const started: OpenClawAgentSource[] = []

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-ondemand-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
  })
  afterEach(async () => {
    for (const src of started.splice(0)) await src.stop()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  const track = (src: OpenClawAgentSource): OpenClawAgentSource => {
    started.push(src)
    return src
  }

  it('opens no connection at start while nothing needs the Gateway, and says not in use', async () => {
    const fake = new CountingGateway()
    const src = track(makeSource(fake))
    await src.start()

    expect(fake.connects).toBe(0)
    expect(src.isInUse()).toBe(false)
    expect(await src.health()).toEqual({
      ok: false,
      connection: 'disconnected',
      lastSyncedAt: null,
      inUse: false,
      // A Gateway URL in settings counts as set up (no isConfigured dep here).
      configured: true,
      message: 'not in use',
    })
  })

  it('an install with an OpenClaw agent still connects and syncs at start', async () => {
    insertAgent('main', 'openclaw')
    const fake = new CountingGateway()
    const src = track(makeSource(fake))
    await src.start()

    expect(fake.connects).toBe(1)
    const health = await src.health()
    expect(health.connection).toBe('connected')
    expect(health.inUse).toBe(true)
    expect(health.message).toBeUndefined()
    expect(health.lastSyncedAt).not.toBeNull()
  })

  it('a source built without hasStandingNeed connects at start, as before', async () => {
    const fake = new CountingGateway()
    const src = track(makeSource(fake, { hasStandingNeed: undefined }))
    await src.start()
    expect(fake.connects).toBe(1)
    expect((await src.health()).inUse).toBe(true)
  })

  it('a standing need that cannot be read is assumed, so the server connects', async () => {
    const fake = new CountingGateway()
    const src = track(
      makeSource(fake, {
        hasStandingNeed: () => {
          throw new Error('database is locked')
        },
      }),
    )
    await src.start()
    expect(fake.connects).toBe(1)
  })

  it('counts only a live OpenClaw agent as a standing need', () => {
    expect(hasLiveOpenClawAgent(getDb())).toBe(false)
    insertAgent('native-1', 'clawboo-native')
    insertAgent('codex-1', 'codex')
    insertAgent('gone', 'openclaw', Date.now())
    expect(hasLiveOpenClawAgent(getDb())).toBe(false)
    insertAgent('main', 'openclaw')
    expect(hasLiveOpenClawAgent(getDb())).toBe(true)
  })

  it('a delete still owed to a Gateway that is set up is a standing need too', () => {
    const setUp = () => true
    expect(hasStandingGatewayNeed(getDb(), setUp)).toBe(false)
    insertAgent('gone', 'openclaw', Date.now())
    expect(hasStandingGatewayNeed(getDb(), setUp)).toBe(false)
    // The last OpenClaw agent, deleted while the Gateway was down: no row left.
    setSetting(getDb(), 'agent-source:openclaw:pendingDelete:main', 'main')
    expect(hasStandingGatewayNeed(getDb(), setUp)).toBe(true)
    // OpenClaw removed since: nothing to send the delete to, so no dialing.
    expect(hasStandingGatewayNeed(getDb(), () => false)).toBe(false)
    // A live OpenClaw agent counts whatever the settings say.
    insertAgent('main', 'openclaw')
    expect(hasStandingGatewayNeed(getDb(), () => false)).toBe(true)
  })

  it('markInUse connects and syncs a started source', async () => {
    const fake = new CountingGateway()
    const src = track(makeSource(fake))
    await src.start()
    expect(fake.connects).toBe(0)

    src.markInUse('a person opened OpenClaw')
    await settle()

    expect(fake.connects).toBe(1)
    expect(src.isConnected()).toBe(true)
    expect(src.isInUse()).toBe(true)
    // The sync that follows a connect brought the Gateway's agent in.
    expect(hasLiveOpenClawAgent(getDb())).toBe(true)
  })

  it('markInUse is idempotent', async () => {
    const fake = new CountingGateway()
    const src = track(makeSource(fake))
    await src.start()
    src.markInUse('one')
    src.markInUse('two')
    await settle()
    src.markInUse('three')
    await settle()
    expect(fake.connects).toBe(1)
  })

  it('a need noted before start connects at start, not before', async () => {
    const fake = new CountingGateway()
    const src = track(makeSource(fake))
    src.markInUse('a request served while the server boots')
    await settle()
    expect(fake.connects).toBe(0)

    await src.start()
    expect(fake.connects).toBe(1)
    expect(src.isConnected()).toBe(true)
  })

  it('notices an OpenClaw agent that appears later, on the next read, and connects', async () => {
    const fake = new CountingGateway()
    const src = track(makeSource(fake))
    await src.start()
    expect((await src.health()).inUse).toBe(false)

    insertAgent('later', 'openclaw')
    expect((await src.health()).inUse).toBe(true)
    await settle()
    expect(fake.connects).toBe(1)
    expect(src.isConnected()).toBe(true)
  })

  it('an explicit reconnect is a need', async () => {
    const fake = new CountingGateway()
    const src = track(makeSource(fake))
    await src.start()

    await src.reconnect()
    expect(fake.connects).toBe(1)
    expect(src.isConnected()).toBe(true)
  })

  it('stays in use across a stop and start (the reconnect path)', async () => {
    const fake = new CountingGateway()
    const src = track(makeSource(fake))
    await src.start()
    src.markInUse('a routine is due')
    await settle()

    await src.stop()
    expect((await src.health()).inUse).toBe(true)
    await src.start()
    expect(fake.connects).toBe(2)
  })

  it('a Gateway that refuses after a need reads as in use and disconnected, not as not in use', async () => {
    const fake = new CountingGateway()
    fake.connectWith = () => Promise.reject(new Error('connect ECONNREFUSED'))
    const src = track(makeSource(fake))
    await src.start()

    const health = await src.markInUseAndWait('a person opened OpenClaw', 1_000)
    expect(fake.connects).toBe(1)
    expect(health.inUse).toBe(true)
    expect(health.connection).toBe('disconnected')
    expect(health.message).toBeUndefined()
  })

  it('markInUseAndWait answers once the connect lands', async () => {
    const fake = new CountingGateway()
    let land: () => void = () => {}
    fake.connectWith = () => new Promise<void>((resolve) => (land = resolve))
    const src = track(makeSource(fake))
    await src.start()

    const answer = src.markInUseAndWait('a person opened OpenClaw', 5_000)
    await settle()
    land()
    const health = await answer
    expect(health.connection).toBe('connected')
    expect(health.inUse).toBe(true)
  })

  it('markInUseAndWait gives up waiting on a Gateway still starting, and answers connecting', async () => {
    const fake = new CountingGateway()
    fake.connectWith = () => new Promise<void>(() => {})
    const src = track(makeSource(fake))
    await src.start()

    const health = await src.markInUseAndWait('a person opened OpenClaw', 50)
    expect(health.connection).toBe('connecting')
    expect(health.inUse).toBe(true)
  })

  // A disconnected GatewayClient never settles the connect it had in flight, and a
  // socket-activated Gateway that is still starting makes such a connect long.
  it('a reconnect while a connect is still in flight connects again, rather than wedging', async () => {
    const fake = new CountingGateway()
    fake.connectWith = () => new Promise<void>(() => {}) // never settles, like a stopped client
    const src = track(makeSource(fake))
    await src.start()
    src.markInUse('a person opened OpenClaw')
    await settle()
    expect(fake.connects).toBe(1)

    fake.connectWith = () => Promise.resolve()
    await src.reconnect()
    expect(fake.connects).toBe(2)
    expect(src.isConnected()).toBe(true)
  })

  it("a stopped client's late failure does not tear down the connection that replaced it", async () => {
    let failFirst: (err: Error) => void = () => {}
    const first = new CountingGateway()
    first.connectWith = () => new Promise<void>((_, reject) => (failFirst = reject))
    const second = new CountingGateway()
    const clients = [first, second]
    const src = track(makeSource(first, { makeClient: () => clients.shift() ?? second }))
    await src.start()
    src.markInUse('a person opened OpenClaw')
    await settle()

    await src.reconnect()
    expect(src.isConnected()).toBe(true)
    failFirst(new Error('socket closed'))
    await settle()
    expect(src.isConnected()).toBe(true)
  })

  it('markInUseAndWait does not answer on the stop inside a reconnect', async () => {
    const fake = new CountingGateway()
    fake.connectWith = () => new Promise<void>(() => {})
    const src = track(makeSource(fake))
    await src.start()
    const answer = src.markInUseAndWait('a person opened OpenClaw', 5_000)
    await settle()

    // The reconnect's second connect lands a little later.
    let land: () => void = () => {}
    fake.connectWith = () => new Promise<void>((resolve) => (land = resolve))
    // reconnect() itself waits for that connect, so it is not awaited first.
    const reconnecting = src.reconnect()
    await new Promise((r) => setTimeout(r, 10))
    land()
    await reconnecting
    expect((await answer).connection).toBe('connected')
  })

  it('reconnectAndWait answers within its deadline though a later reconnect superseded its connect', async () => {
    // Two deliveries each recover the operator. The second reconnect tears down
    // the first one's client, whose connect then never settles: the first
    // delivery must still answer, and with the second's connection.
    const hung = () => new Promise<void>(() => {})
    const clients = [new CountingGateway(), new CountingGateway(), new CountingGateway()]
    clients[0]!.connectWith = hung
    clients[1]!.connectWith = hung
    const src = track(makeSource(clients[0]!, { makeClient: () => clients.shift()! }))
    await src.start()
    src.markInUse('a delivery')
    await settle()

    const first = src.reconnectAndWait(2_000)
    await settle()
    const second = src.reconnectAndWait(2_000)
    const late = new Promise<string>((r) => setTimeout(() => r('still waiting'), 1_500))
    expect(await Promise.race([second, late])).toBe(true)
    expect(await Promise.race([first, late])).toBe(true)
  })
})
