// The gateway-cron source against a fake operator client: field mapping
// (own-life domain, owner 'openclaw', disabled→paused), the EXACT operator
// methods + params for every write (cron.add / cron.update incl. the
// {id, enabled} toggle / cron.remove / cron.run {id, mode:'force'}),
// disconnected degradation (read = data, write = typed 503), the team-task
// domain refusal, and the debounced refresh on broadcast `cron` frames.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScheduleSourceUnavailableError, TeamTaskDomainViolationError } from '@clawboo/scheduler'

import {
  OpenClawGatewayCronScheduleSource,
  type OperatorCronClientLike,
} from '../openClawGatewayCronScheduleSource'

interface RecordedCall {
  method: string
  params?: unknown
}

function makeFakeClient(opts: { connected?: boolean; jobs?: unknown[] } = {}) {
  const calls: RecordedCall[] = []
  const broadcastListeners = new Set<(frame: { event: string; payload?: unknown }) => void>()
  let connected = opts.connected ?? true
  const client: OperatorCronClientLike & {
    calls: RecordedCall[]
    emit: (frame: { event: string }) => void
    setConnected: (v: boolean) => void
  } = {
    calls,
    isConnected: () => connected,
    operatorCall: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params })
      if (method === 'cron.list') return { jobs: opts.jobs ?? [] } as T
      if (method === 'cron.add') {
        const p = params as Record<string, unknown>
        return {
          id: 'job-new',
          name: p['name'],
          agentId: p['agentId'],
          enabled: true,
          schedule: p['schedule'],
          state: {},
        } as T
      }
      if (method === 'cron.get') {
        return {
          id: (params as { id: string }).id,
          name: 'after',
          enabled: true,
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          state: {},
        } as T
      }
      return undefined as T
    },
    onGatewayBroadcast: (cb) => {
      broadcastListeners.add(cb)
      return () => broadcastListeners.delete(cb)
    },
    emit: (frame) => {
      for (const cb of broadcastListeners) cb(frame)
    },
    setConnected: (v) => {
      connected = v
    },
  }
  return client
}

const SAMPLE_JOBS = [
  {
    id: 'job-1',
    name: 'Morning summary to Telegram',
    agentId: 'gw-agent-1',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/New_York' },
    state: { nextRunAtMs: 1_750_000_000_000, lastRunAtMs: 1_749_900_000_000, lastStatus: 'ok' },
  },
  {
    id: 'job-2',
    name: 'Disabled chore',
    agentId: 'gw-agent-1',
    enabled: false,
    schedule: { kind: 'every', everyMs: 3_600_000 },
    state: {},
  },
  {
    id: 'job-3',
    name: 'Broken chore',
    enabled: true,
    schedule: { kind: 'at', at: '2026-07-01T09:00:00.000Z' },
    state: { lastStatus: 'error', lastError: 'boom' },
  },
]

describe('OpenClawGatewayCronScheduleSource', () => {
  it('maps gateway jobs into runtime-own-life records (never team-task)', async () => {
    const source = new OpenClawGatewayCronScheduleSource(makeFakeClient({ jobs: SAMPLE_JOBS }))
    const { records, status } = await source.read()

    expect(status).toMatchObject({ sourceId: 'openclaw-gateway-cron', ok: true, degraded: false })
    expect(records).toHaveLength(3)
    expect(records.every((r) => r.domain === 'runtime-own-life')).toBe(true)
    expect(records.every((r) => r.owner === 'openclaw')).toBe(true)
    expect(records.every((r) => r.manageability === 'external-write')).toBe(true)
    expect(records.every((r) => r.teamTaskId === undefined)).toBe(true)

    expect(records[0]).toMatchObject({
      id: 'openclaw-gateway-cron:job-1',
      sourceScheduleId: 'job-1',
      runtime: 'openclaw',
      agentId: 'gw-agent-1',
      label: 'Morning summary to Telegram',
      cronSpec: '0 8 * * *@tz:America/New_York',
      nextRunAt: 1_750_000_000_000,
      status: 'idle',
    })
    expect(records[1]).toMatchObject({ status: 'paused', cronSpec: 'every:3600000' })
    expect(records[2]).toMatchObject({
      status: 'error',
      lastError: 'boom',
      cronSpec: 'at:2026-07-01T09:00:00.000Z',
    })
  })

  it('calls the EXACT operator method + params per write action', async () => {
    const client = makeFakeClient()
    const source = new OpenClawGatewayCronScheduleSource(client)

    const created = await source.write({
      kind: 'create',
      spec: {
        source: 'openclaw-gateway-cron',
        domain: 'runtime-own-life',
        agentId: 'gw-agent-1',
        cronSpec: '0 8 * * *',
        label: 'Own-life wake',
      },
    })
    expect(created?.id).toBe('openclaw-gateway-cron:job-new')
    expect(client.calls[0]).toEqual({
      method: 'cron.add',
      params: {
        name: 'Own-life wake',
        agentId: 'gw-agent-1',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 8 * * *' },
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: 'Own-life wake' },
      },
    })

    client.calls.length = 0
    await source.write({
      kind: 'update',
      id: 'openclaw-gateway-cron:job-1',
      patch: { cronSpec: 'every:60000', label: 'renamed' },
    })
    expect(client.calls[0]).toEqual({
      method: 'cron.update',
      params: { id: 'job-1', name: 'renamed', schedule: { kind: 'every', everyMs: 60_000 } },
    })
    expect(client.calls[1]?.method).toBe('cron.get')

    client.calls.length = 0
    await source.write({ kind: 'pause', id: 'openclaw-gateway-cron:job-1' })
    expect(client.calls[0]).toEqual({
      method: 'cron.update',
      params: { id: 'job-1', enabled: false },
    })

    client.calls.length = 0
    await source.write({ kind: 'resume', id: 'openclaw-gateway-cron:job-1' })
    expect(client.calls[0]).toEqual({
      method: 'cron.update',
      params: { id: 'job-1', enabled: true },
    })

    client.calls.length = 0
    expect(await source.write({ kind: 'remove', id: 'openclaw-gateway-cron:job-1' })).toBeNull()
    expect(client.calls[0]).toEqual({ method: 'cron.remove', params: { id: 'job-1' } })

    client.calls.length = 0
    expect(await source.write({ kind: 'run', id: 'openclaw-gateway-cron:job-1' })).toBeNull()
    expect(client.calls[0]).toEqual({ method: 'cron.run', params: { id: 'job-1', mode: 'force' } })
  })

  it('REFUSES registering a team task into the Gateway cron', async () => {
    const client = makeFakeClient()
    const source = new OpenClawGatewayCronScheduleSource(client)
    await expect(
      source.write({
        kind: 'create',
        spec: {
          source: 'openclaw-gateway-cron',
          domain: 'team-task',
          agentId: 'a1',
          cronSpec: '0 9 * * *',
        },
      }),
    ).rejects.toBeInstanceOf(TeamTaskDomainViolationError)
    expect(client.calls).toHaveLength(0)
  })

  it('disconnected: read degrades as data, writes throw the typed 503', async () => {
    const client = makeFakeClient({ connected: false })
    const source = new OpenClawGatewayCronScheduleSource(client)

    const { records, status } = await source.read()
    expect(records).toEqual([])
    expect(status).toMatchObject({ ok: false, degraded: true, reason: 'gateway_disconnected' })

    await expect(
      source.write({ kind: 'remove', id: 'openclaw-gateway-cron:job-1' }),
    ).rejects.toBeInstanceOf(ScheduleSourceUnavailableError)
    expect(client.calls).toHaveLength(0)
  })

  it('serves a warm cache as stale when the Gateway drops mid-session', async () => {
    const client = makeFakeClient({ jobs: SAMPLE_JOBS })
    const source = new OpenClawGatewayCronScheduleSource(client)
    await source.read() // warms the cache
    client.setConnected(false)
    const { records, status } = await source.read()
    expect(records).toHaveLength(3)
    expect(status).toMatchObject({ ok: false, degraded: true, reason: 'stale_cache' })
  })

  describe('broadcast refresh', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('a broadcast cron frame triggers ONE debounced cron.list refresh', async () => {
      const client = makeFakeClient({ jobs: SAMPLE_JOBS })
      const source = new OpenClawGatewayCronScheduleSource(client)
      expect(source.id).toBe('openclaw-gateway-cron')

      client.emit({ event: 'cron' })
      client.emit({ event: 'cron' })
      client.emit({ event: 'presence' }) // ignored
      expect(client.calls.filter((c) => c.method === 'cron.list')).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(800)
      expect(client.calls.filter((c) => c.method === 'cron.list')).toHaveLength(1)
    })
  })
})
