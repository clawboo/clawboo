// Hermes's own jobs as the third schedule source: the agent's own life
// (`runtime-own-life`), read and written through each agent's profile on the
// supervised gateway. Team work is refused, as it is through OpenClaw's cron.

import { describe, expect, it } from 'vitest'

import {
  InvalidRoutineTargetError,
  ScheduleMultiplexer,
  ScheduleSourceUnavailableError,
  TeamTaskDomainViolationError,
  UnknownScheduleError,
  parseScheduleId,
} from '@clawboo/scheduler'

import { HermesApiError, type HermesClient, type HermesJob } from '../../runtimes/hermes/client'
import {
  HermesGatewayJobsScheduleSource,
  hermesScheduleShape,
  hermesScheduleString,
  type HermesJobsBackend,
} from '../hermesGatewayJobsScheduleSource'

const job = (over: Partial<HermesJob> = {}): HermesJob => ({
  id: 'abcdef012345',
  name: 'nightly',
  prompt: 'summarize the day',
  enabled: true,
  state: 'scheduled',
  schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
  next_run_at: '2026-11-12T09:00:00-05:00',
  last_run_at: null,
  last_status: null,
  ...over,
})

function fakeClient(jobs: HermesJob[]) {
  const calls: { method: string; args: unknown[] }[] = []
  const rec =
    (method: string, out?: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return out
    }
  const client = {
    listJobs: async () => jobs,
    getJob: async (id: string) => jobs.find((j) => j.id === id) ?? job({ id }),
    createJob: async (spec: { name: string; schedule: string; prompt: string }) => {
      calls.push({ method: 'createJob', args: [spec] })
      return job({ id: '0123456789ab', name: spec.name, prompt: spec.prompt })
    },
    updateJob: async (id: string, patch: Record<string, unknown>) => {
      calls.push({ method: 'updateJob', args: [id, patch] })
      return job({ id, ...(patch['name'] ? { name: String(patch['name']) } : {}) })
    },
    deleteJob: rec('deleteJob'),
    pauseJob: rec('pauseJob'),
    resumeJob: rec('resumeJob'),
    runJob: rec('runJob'),
  } as unknown as HermesClient
  return { client, calls }
}

function backend(running: boolean, client: HermesClient, configured = true): HermesJobsBackend {
  return {
    configured: () => configured,
    agentClients: async () =>
      running ? [{ agentId: 'agent-1', profile: 'cb-agent-1', client }] : null,
    clientFor: async (agentId) =>
      agentId === 'agent-1' ? { profile: 'cb-agent-1', client } : null,
    agentForProfile: async (profile) => (profile === 'cb-agent-1' ? 'agent-1' : null),
  }
}

describe('HermesGatewayJobsScheduleSource', () => {
  it("lists each agent's own jobs as runtime-own-life rows Hermes fires", async () => {
    const { client } = fakeClient([
      job(),
      job({ id: 'bbbbbbbbbbbb', name: 'hourly', schedule: { kind: 'interval', minutes: 60 } }),
      job({ id: 'cccccccccccc', name: 'off', enabled: false, state: 'paused' }),
    ])
    const source = new HermesGatewayJobsScheduleSource(backend(true, client))
    const { records, status } = await source.read()
    expect(status).toMatchObject({ sourceId: 'hermes-gateway-jobs', ok: true })
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({
      id: 'hermes-gateway-jobs:cb-agent-1.abcdef012345',
      runtime: 'hermes',
      owner: 'hermes',
      agentId: 'agent-1',
      label: 'nightly',
      description: 'summarize the day',
      cronSpec: '0 9 * * *',
      domain: 'runtime-own-life',
      manageability: 'external-write',
      status: 'idle',
      nextRunAt: Date.parse('2026-11-12T09:00:00-05:00'),
    })
    expect(records[1]!.cronSpec).toBe('every:3600000')
    expect(records[2]).toMatchObject({ status: 'paused', nextRunAt: null })
    // The multiplexer knows the new id space.
    expect(parseScheduleId(records[0]!.id)).toEqual({
      source: 'hermes-gateway-jobs',
      sourceScheduleId: 'cb-agent-1.abcdef012345',
    })
  })

  it('degrades, never throws, while the gateway is stopped, serving the last list', async () => {
    const { client } = fakeClient([job()])
    let running = true
    const source = new HermesGatewayJobsScheduleSource({
      ...backend(true, client),
      agentClients: async () =>
        running ? [{ agentId: 'agent-1', profile: 'cb-agent-1', client }] : null,
    })
    await source.read()
    running = false
    const stale = await source.read()
    expect(stale.status).toMatchObject({ ok: false, degraded: true, reason: 'stale_cache' })
    expect(stale.records).toHaveLength(1)
    const cold = await new HermesGatewayJobsScheduleSource(backend(false, client)).read()
    expect(cold.status).toMatchObject({ degraded: true, reason: 'gateway_stopped' })
  })

  it('says the gateway is stopped, not stale, when its last list was empty', async () => {
    const { client } = fakeClient([])
    let running = true
    const source = new HermesGatewayJobsScheduleSource({
      ...backend(true, client),
      agentClients: async () =>
        running ? [{ agentId: 'agent-1', profile: 'cb-agent-1', client }] : null,
    })
    await source.read()
    running = false
    expect((await source.read()).status).toMatchObject({ reason: 'gateway_stopped' })
  })

  it('names one unreadable profile as that, not as a stopped gateway', async () => {
    const { client } = fakeClient([job()])
    const broken = {
      listJobs: async () => {
        throw new HermesApiError('Hermes answered 500', 500, null)
      },
    } as unknown as HermesClient
    const source = new HermesGatewayJobsScheduleSource({
      ...backend(true, client),
      agentClients: async () => [
        { agentId: 'agent-1', profile: 'cb-agent-1', client },
        { agentId: 'agent-2', profile: 'cb-agent-2', client: broken },
      ],
    })
    const out = await source.read()
    expect(out.records).toHaveLength(1)
    expect(out.status).toMatchObject({ degraded: true, reason: 'profile_unreadable' })
  })

  it('names a profile that refuses its key as unreadable, and an unknown one as empty', async () => {
    const { client } = fakeClient([job()])
    const answering = (status: number) =>
      ({
        listJobs: async () => {
          throw new HermesApiError('refused', status, null)
        },
      }) as unknown as HermesClient
    const read = (other: HermesClient) =>
      new HermesGatewayJobsScheduleSource({
        ...backend(true, client),
        agentClients: async () => [
          { agentId: 'agent-1', profile: 'cb-agent-1', client },
          { agentId: 'agent-2', profile: 'cb-agent-2', client: other },
        ],
      }).read()
    // Hermes serves the profile but not with this key: its jobs still fire, unseen.
    const refused = await read(answering(401))
    expect(refused.records).toHaveLength(1)
    expect(refused.status).toMatchObject({ degraded: true, reason: 'profile_unreadable' })
    // Hermes has no such profile (the agent never ran): nothing to show.
    const unknown = await read(answering(404))
    expect(unknown.records).toHaveLength(1)
    expect(unknown.status).toMatchObject({ ok: true, degraded: false })
  })

  it('reads as off, not unknown, when Hermes is not in use', async () => {
    const { client } = fakeClient([job()])
    const off = await new HermesGatewayJobsScheduleSource(backend(true, client, false)).read()
    expect(off).toEqual({
      records: [],
      status: expect.objectContaining({ ok: false, degraded: false, reason: 'not_configured' }),
    })
  })

  it('refuses team work: a team-task create never reaches Hermes', async () => {
    const { client, calls } = fakeClient([])
    const source = new HermesGatewayJobsScheduleSource(backend(true, client))
    await expect(
      source.write({
        kind: 'create',
        spec: {
          source: 'hermes-gateway-jobs',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: '0 9 * * *',
        },
      }),
    ).rejects.toBeInstanceOf(TeamTaskDomainViolationError)
    // The multiplexer gate refuses it too.
    const mux = new ScheduleMultiplexer()
    mux.register(source)
    await expect(
      mux.write({
        kind: 'create',
        spec: {
          source: 'hermes-gateway-jobs',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: '0 9 * * *',
        },
      }),
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('creates, edits, pauses, resumes, runs and removes through the agent profile', async () => {
    const { client, calls } = fakeClient([job()])
    const source = new HermesGatewayJobsScheduleSource(backend(true, client))
    const created = await source.write({
      kind: 'create',
      spec: {
        source: 'hermes-gateway-jobs',
        domain: 'runtime-own-life',
        agentId: 'agent-1',
        cronSpec: 'every:1800000',
        label: 'check in',
        payload: { message: 'look at the inbox' },
      },
    })
    expect(calls[0]).toEqual({
      method: 'createJob',
      args: [{ name: 'check in', schedule: 'every 30m', prompt: 'look at the inbox' }],
    })
    expect(created?.agentId).toBe('agent-1')

    const id = 'hermes-gateway-jobs:cb-agent-1.abcdef012345'
    await source.write({ kind: 'update', id, patch: { label: 'renamed', cronSpec: '0 7 * * 1' } })
    expect(calls.at(-1)).toEqual({
      method: 'updateJob',
      args: ['abcdef012345', { name: 'renamed', schedule: '0 7 * * 1' }],
    })
    for (const kind of ['pause', 'resume', 'run', 'remove'] as const) {
      await source.write({ kind, id })
    }
    expect(calls.slice(-4).map((c) => c.method)).toEqual([
      'pauseJob',
      'resumeJob',
      'runJob',
      'deleteJob',
    ])
    await expect(
      source.write({ kind: 'pause', id: 'hermes-gateway-jobs:cb-nobody.abcdef012345' }),
    ).rejects.toBeInstanceOf(UnknownScheduleError)
  })
})

describe('what a Hermes job cannot be', () => {
  const create = (spec: Record<string, unknown>) => ({
    kind: 'create' as const,
    spec: {
      source: 'hermes-gateway-jobs' as const,
      domain: 'runtime-own-life' as const,
      agentId: 'agent-1',
      cronSpec: '0 9 * * *',
      label: 'x',
      payload: { prompt: 'p' },
      ...spec,
    },
  })

  it('refuses team work named by its target, team, task or template', async () => {
    const { client, calls } = fakeClient([])
    const source = new HermesGatewayJobsScheduleSource(backend(true, client))
    for (const spec of [
      { target: 'team' },
      { teamId: 'team-1' },
      { teamTaskId: 'task-1' },
      { taskTemplate: { title: 't' } },
    ]) {
      await expect(source.write(create(spec) as never)).rejects.toBeInstanceOf(
        InvalidRoutineTargetError,
      )
    }
    expect(calls).toHaveLength(0)
  })

  it('refuses a start time, and moving a job to another agent or team', async () => {
    const { client, calls } = fakeClient([job()])
    const source = new HermesGatewayJobsScheduleSource(backend(true, client))
    await expect(
      source.write(create({ cronSpec: 'every:600000@anchor:1700000000000' }) as never),
    ).rejects.toBeInstanceOf(InvalidRoutineTargetError)
    const id = 'hermes-gateway-jobs:cb-agent-1.abcdef012345'
    for (const patch of [{ agentId: 'agent-2' }, { teamId: 'team-1' }, { target: 'team' }]) {
      await expect(source.write({ kind: 'update', id, patch } as never)).rejects.toBeInstanceOf(
        InvalidRoutineTargetError,
      )
    }
    expect(calls).toHaveLength(0)
  })

  it('asks for a first run before a job for an agent Hermes has no profile for', async () => {
    const { client } = fakeClient([])
    const answering = (status: number) =>
      new HermesGatewayJobsScheduleSource(
        backend(true, {
          ...client,
          createJob: async () => {
            throw new HermesApiError('refused', status, null)
          },
        } as unknown as HermesClient),
      )
    // Hermes has no such profile until the agent's first run.
    await expect(answering(404).write(create({}) as never)).rejects.toThrow(/Run this agent once/)
    // A profile Hermes has, refusing the key, is not that.
    await expect(answering(401).write(create({}) as never)).rejects.toBeInstanceOf(
      ScheduleSourceUnavailableError,
    )
  })
})

describe('a gateway that cannot start', () => {
  it('makes a write unavailable (503), not a server error', async () => {
    const { client } = fakeClient([])
    const source = new HermesGatewayJobsScheduleSource({
      ...backend(true, client),
      clientFor: async () => {
        throw new Error('Hermes is not installed by Clawboo.')
      },
    })
    await expect(
      source.write({ kind: 'run', id: 'hermes-gateway-jobs:cb-agent-1.abcdef012345' }),
    ).rejects.toBeInstanceOf(ScheduleSourceUnavailableError)
  })
})

describe('Hermes schedule codec', () => {
  it('maps Hermes schedules to the unified spec and back', () => {
    expect(
      hermesScheduleShape(job({ schedule: { kind: 'once', run_at: '2026-12-01T10:00:00Z' } })),
    ).toEqual({
      kind: 'at',
      at: '2026-12-01T10:00:00Z',
    })
    expect(hermesScheduleString('0 9 * * *')).toBe('0 9 * * *')
    expect(hermesScheduleString('every:600000')).toBe('every 10m')
    expect(hermesScheduleString('at:2026-12-01T10:00:00Z')).toBe('2026-12-01T10:00:00Z')
    expect(() => hermesScheduleString('every:90000')).toThrow(/whole minutes/)
    expect(() => hermesScheduleString('0 9 * * *@tz:Europe/Berlin')).toThrow(/time zone/)
  })
})
