import { describe, expect, it } from 'vitest'

import { UnknownCapabilityError, UnsupportedCapabilityWriteError, unsupported } from '../errors'
import type { CapabilityRecord } from '../records'
import { CapabilityMultiplexer, makeCapabilityId, parseCapabilityId } from '../registry'
import type { CapabilityReadResult, CapabilitySource, CapabilityWriteAction } from '../source'

function rec(id: string, over: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    id,
    sourceKey: 'k',
    kind: 'tool',
    runtime: 'clawboo-native',
    scope: 'global',
    agentId: null,
    source: 'brokered-mcp',
    manageability: 'managed',
    name: 'tool',
    description: '',
    availability: null,
    available: true,
    diagnostics: [],
    provenance: null,
    status: 'ready',
    tenantId: null,
    syncedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

class FakeSource implements CapabilitySource {
  written: CapabilityWriteAction[] = []
  constructor(
    readonly id: CapabilitySource['id'],
    private readonly records: CapabilityRecord[],
    private readonly opts: { throwOnRead?: boolean; observeOnly?: boolean } = {},
  ) {}
  async read(): Promise<CapabilityReadResult> {
    if (this.opts.throwOnRead) throw new Error('boom')
    return {
      records: this.records,
      status: { sourceId: this.id, ok: true, degraded: false, at: 1 },
    }
  }
  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    if (this.opts.observeOnly) unsupported(this.id, action.kind)
    this.written.push(action)
    return null
  }
}

describe('makeCapabilityId / parseCapabilityId', () => {
  it('round-trips, splitting on the first colon so a rawKey with colons survives', () => {
    const id = makeCapabilityId('hermes', 'agent:a1:mcp:memory')
    expect(id).toBe('hermes:agent:a1:mcp:memory')
    expect(parseCapabilityId(id)).toEqual({ sourceId: 'hermes', rawKey: 'agent:a1:mcp:memory' })
  })
  it('returns null for an un-prefixed id', () => {
    expect(parseCapabilityId('not-a-source:x')).toBeNull()
  })
})

describe('CapabilityMultiplexer.read', () => {
  it('fans across sources and NEVER rejects — a throwing source becomes a degraded status', async () => {
    const mux = new CapabilityMultiplexer()
    mux.register(new FakeSource('native', [rec('native:a')]))
    mux.register(new FakeSource('hermes', [], { throwOnRead: true }))
    const { records, sources } = await mux.read()
    expect(records.map((r) => r.id)).toEqual(['native:a'])
    const hermes = sources.find((s) => s.sourceId === 'hermes')
    expect(hermes).toMatchObject({ ok: false, degraded: true })
    expect(sources.find((s) => s.sourceId === 'native')).toMatchObject({ ok: true })
  })
})

describe('CapabilityMultiplexer.write', () => {
  it('routes install by spec.via and enable/disable by the id prefix', async () => {
    const native = new FakeSource('native', [])
    const openclaw = new FakeSource('openclaw', [])
    const mux = new CapabilityMultiplexer()
    mux.register(native)
    mux.register(openclaw)

    await mux.write({
      kind: 'install',
      spec: { via: 'native', agentId: 'a1', runtime: 'openclaw', kind: 'skill', name: 'x' },
    })
    await mux.write({ kind: 'enable', id: 'openclaw:tool:foo' })

    expect(native.written).toHaveLength(1)
    expect(native.written[0]?.kind).toBe('install')
    expect(openclaw.written).toHaveLength(1)
    expect(openclaw.written[0]).toEqual({ kind: 'enable', id: 'openclaw:tool:foo' })
  })

  it('throws UnknownCapabilityError for an unknown source', async () => {
    const mux = new CapabilityMultiplexer()
    await expect(mux.write({ kind: 'enable', id: 'native:x' })).rejects.toBeInstanceOf(
      UnknownCapabilityError,
    )
  })

  it('propagates the observe-only unsupported() throw from a source', async () => {
    const mux = new CapabilityMultiplexer()
    mux.register(new FakeSource('hermes', [], { observeOnly: true }))
    await expect(mux.write({ kind: 'disable', id: 'hermes:x' })).rejects.toBeInstanceOf(
      UnsupportedCapabilityWriteError,
    )
  })
})
