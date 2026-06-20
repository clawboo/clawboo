import { describe, expect, it } from 'vitest'

import {
  TeamTaskDomainViolationError,
  UnknownScheduleError,
  UnsupportedScheduleWriteError,
} from '../errors'
import { ScheduleMultiplexer, makeScheduleId, parseScheduleId } from '../multiplexer'
import type { ScheduleRecord } from '../records'
import type { ScheduleSource, ScheduleWriteAction } from '../source'

function record(
  partial: Partial<ScheduleRecord> & Pick<ScheduleRecord, 'id' | 'source' | 'domain'>,
): ScheduleRecord {
  return {
    sourceScheduleId: partial.id.split(':').slice(1).join(':'),
    runtime: 'clawboo-native',
    owner: 'clawboo',
    agentId: 'a1',
    cronSpec: '0 9 * * *',
    nextRunAt: null,
    status: 'idle',
    manageability: 'managed',
    tenantId: null,
    ...partial,
  }
}

function fakeSource(
  overrides: Partial<ScheduleSource> & Pick<ScheduleSource, 'id' | 'domain' | 'manageability'>,
): ScheduleSource & { writes: ScheduleWriteAction[] } {
  const writes: ScheduleWriteAction[] = []
  return {
    read: async () => ({
      records: [],
      status: { sourceId: overrides.id, ok: true, degraded: false, at: 1 },
    }),
    write: async (action) => {
      writes.push(action)
      return null
    },
    ...overrides,
    writes,
  }
}

describe('schedule id codec', () => {
  it('round-trips composite ids', () => {
    const id = makeScheduleId('openclaw-gateway-cron', 'job-1')
    expect(id).toBe('openclaw-gateway-cron:job-1')
    expect(parseScheduleId(id)).toEqual({
      source: 'openclaw-gateway-cron',
      sourceScheduleId: 'job-1',
    })
    // Raw ids containing ':' survive.
    expect(parseScheduleId('clawboo-routine:a:b')).toEqual({
      source: 'clawboo-routine',
      sourceScheduleId: 'a:b',
    })
  })

  it('rejects unknown prefixes and empty raws', () => {
    expect(parseScheduleId('mystery:1')).toBeNull()
    expect(parseScheduleId('clawboo-routine:')).toBeNull()
  })
})

describe('ScheduleMultiplexer.read', () => {
  it('merges records across sources and never conflates domains', async () => {
    const mux = new ScheduleMultiplexer()
    mux.register(
      fakeSource({
        id: 'clawboo-routine',
        domain: 'team-task',
        manageability: 'managed',
        read: async () => ({
          records: [
            record({ id: 'clawboo-routine:r1', source: 'clawboo-routine', domain: 'team-task' }),
          ],
          status: { sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 },
        }),
      }),
    )
    mux.register(
      fakeSource({
        id: 'openclaw-gateway-cron',
        domain: 'runtime-own-life',
        manageability: 'external-write',
        read: async () => ({
          records: [
            record({
              id: 'openclaw-gateway-cron:j1',
              source: 'openclaw-gateway-cron',
              domain: 'runtime-own-life',
              owner: 'openclaw',
              manageability: 'external-write',
            }),
          ],
          status: { sourceId: 'openclaw-gateway-cron', ok: true, degraded: false, at: 1 },
        }),
      }),
    )

    const merged = await mux.read()
    expect(merged.records).toHaveLength(2)
    const domains = new Map(merged.records.map((r) => [r.source, r.domain]))
    expect(domains.get('clawboo-routine')).toBe('team-task')
    expect(domains.get('openclaw-gateway-cron')).toBe('runtime-own-life')
    expect(merged.sources).toHaveLength(2)
  })

  it('a degraded source and a THROWING source both surface as status, never sink the merge', async () => {
    const mux = new ScheduleMultiplexer()
    mux.register(
      fakeSource({
        id: 'clawboo-routine',
        domain: 'team-task',
        manageability: 'managed',
        read: async () => ({
          records: [
            record({ id: 'clawboo-routine:r1', source: 'clawboo-routine', domain: 'team-task' }),
          ],
          status: { sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 },
        }),
      }),
    )
    mux.register(
      fakeSource({
        id: 'openclaw-gateway-cron',
        domain: 'runtime-own-life',
        manageability: 'external-write',
        read: async () => {
          throw new Error('contract violation')
        },
      }),
    )

    const merged = await mux.read()
    expect(merged.records).toHaveLength(1)
    const gw = merged.sources.find((s) => s.sourceId === 'openclaw-gateway-cron')
    expect(gw).toMatchObject({ ok: false, degraded: true })
    expect(gw?.reason).toContain('contract violation')
  })
})

describe('ScheduleMultiplexer.write', () => {
  it('routes create by spec.source and id-actions by id prefix', async () => {
    const mux = new ScheduleMultiplexer()
    const routine = fakeSource({
      id: 'clawboo-routine',
      domain: 'team-task',
      manageability: 'managed',
    })
    const gateway = fakeSource({
      id: 'openclaw-gateway-cron',
      domain: 'runtime-own-life',
      manageability: 'external-write',
    })
    mux.register(routine)
    mux.register(gateway)

    await mux.write({
      kind: 'create',
      spec: {
        source: 'clawboo-routine',
        domain: 'team-task',
        agentId: 'a1',
        cronSpec: '0 9 * * *',
      },
    })
    await mux.write({ kind: 'pause', id: 'openclaw-gateway-cron:j1' })

    expect(routine.writes).toHaveLength(1)
    expect(routine.writes[0]?.kind).toBe('create')
    expect(gateway.writes).toHaveLength(1)
    expect(gateway.writes[0]).toEqual({ kind: 'pause', id: 'openclaw-gateway-cron:j1' })
  })

  it('observe-only sources throw typed unsupported() before the source is touched', async () => {
    const mux = new ScheduleMultiplexer()
    const readonly = fakeSource({
      id: 'openclaw-gateway-cron',
      domain: 'runtime-own-life',
      manageability: 'observe-only',
    })
    mux.register(readonly)

    await expect(
      mux.write({ kind: 'remove', id: 'openclaw-gateway-cron:j1' }),
    ).rejects.toBeInstanceOf(UnsupportedScheduleWriteError)
    expect(readonly.writes).toHaveLength(0)
  })

  it('refuses registering a TEAM task into a runtime-own-life source', async () => {
    const mux = new ScheduleMultiplexer()
    const gateway = fakeSource({
      id: 'openclaw-gateway-cron',
      domain: 'runtime-own-life',
      manageability: 'external-write',
    })
    mux.register(gateway)

    await expect(
      mux.write({
        kind: 'create',
        spec: {
          source: 'openclaw-gateway-cron',
          domain: 'team-task',
          agentId: 'a1',
          cronSpec: '0 9 * * *',
        },
      }),
    ).rejects.toBeInstanceOf(TeamTaskDomainViolationError)
    expect(gateway.writes).toHaveLength(0)
  })

  it('unknown ids and unregistered sources throw UnknownScheduleError', async () => {
    const mux = new ScheduleMultiplexer()
    await expect(mux.write({ kind: 'remove', id: 'mystery:1' })).rejects.toBeInstanceOf(
      UnknownScheduleError,
    )
    await expect(
      mux.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'a1',
          cronSpec: '0 9 * * *',
        },
      }),
    ).rejects.toBeInstanceOf(UnknownScheduleError)
  })
})
