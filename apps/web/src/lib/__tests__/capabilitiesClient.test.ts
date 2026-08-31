// capabilitiesClient — defensive REST helpers (never throw). The `ok` discriminant
// on fetchCapabilities is the signal both the Ghost Graph (filesError) and the
// Capabilities dashboard (error banner) use to distinguish a FETCH FAILURE from a
// genuinely empty inventory. fetch is stubbed per-case.

import type { CapabilityRecord } from '@clawboo/capability-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchCapabilities, groupAgentCapabilities } from '../capabilitiesClient'

const cap = (over: Partial<CapabilityRecord>): CapabilityRecord =>
  ({
    id: over.name ?? 'x',
    sourceKey: over.sourceKey ?? over.name ?? 'x',
    kind: 'tool',
    runtime: 'clawboo-native',
    scope: 'agent',
    agentId: null,
    source: 'brokered-mcp',
    manageability: 'managed',
    name: over.name ?? 'X',
    description: '',
    availability: null,
    available: true,
    diagnostics: [],
    provenance: null,
    status: 'ready',
    tenantId: null,
    syncedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as CapabilityRecord

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl) as unknown as typeof fetch)
}
const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const fail = (status = 500): Response =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response

afterEach(() => vi.unstubAllGlobals())

describe('fetchCapabilities', () => {
  it('returns ok:true with the records/sources on a successful fetch', async () => {
    stubFetch(() =>
      ok({ records: [{ id: 'native:echo' }], sources: [{ sourceId: 'native', ok: true }] }),
    )
    const view = await fetchCapabilities()
    expect(view.ok).toBe(true)
    expect(view.records).toHaveLength(1)
    expect(view.sources).toHaveLength(1)
  })

  it('returns ok:false (empty view) on a non-2xx response — a failure, not genuine emptiness', async () => {
    stubFetch(() => fail(500))
    const view = await fetchCapabilities()
    expect(view.ok).toBe(false)
    expect(view.records).toEqual([])
    expect(view.sources).toEqual([])
  })

  it('returns ok:false on a network throw', async () => {
    stubFetch(() => {
      throw new Error('network down')
    })
    const view = await fetchCapabilities()
    expect(view.ok).toBe(false)
  })
})

describe('groupAgentCapabilities — inherit-if-empty', () => {
  it('an agent with its OWN agent-scoped caps shows those, NOT the shared globals', () => {
    const records = [
      cap({ scope: 'agent', agentId: 'native-1', runtime: 'clawboo-native', name: 'memory MCP' }),
      cap({ scope: 'global', runtime: 'clawboo-native', name: 'echo' }), // shared broker tool
    ]
    const out = groupAgentCapabilities(records, new Map([['native-1', 'clawboo-native']]))
    expect((out.get('native-1') ?? []).map((r) => r.name)).toEqual(['memory MCP'])
  })

  it("an agent with NO caps inherits its runtime's shared (global) caps", () => {
    const records = [
      cap({ scope: 'global', runtime: 'codex', kind: 'connector', name: 'clawboo-tasks' }),
      cap({ scope: 'global', runtime: 'codex', name: 'Built-in tools' }),
    ]
    const out = groupAgentCapabilities(records, new Map([['codex-1', 'codex']]))
    expect((out.get('codex-1') ?? []).map((r) => r.name).sort()).toEqual([
      'Built-in tools',
      'clawboo-tasks',
    ])
  })

  it('does NOT inherit across runtimes — a codex agent gets no native globals', () => {
    const records = [cap({ scope: 'global', runtime: 'clawboo-native', name: 'echo' })]
    const out = groupAgentCapabilities(records, new Map([['codex-1', 'codex']]))
    expect(out.has('codex-1')).toBe(false)
  })

  // clawboo's OWN outbound connections, which the operator turned on in the
  // Connectors tab. Distinguished from a runtime's own MCP config by the
  // `connector:` source id in the record id.
  const connected = (name: string) =>
    cap({
      id: `connector:clawboo-native:global:global:connector:mcp:${name}`,
      scope: 'global',
      runtime: 'clawboo-native',
      kind: 'connector',
      source: 'mcp-connector',
      name,
    })

  /** The agent-scoped twin the grant projection emits for a granted connector. */
  const granted = (name: string, agentId: string) =>
    cap({
      id: `connector:clawboo-native:global:global:connector:mcp:${name}#grant:g-${agentId}`,
      scope: 'agent',
      agentId,
      runtime: 'clawboo-native',
      kind: 'connector',
      source: 'mcp-connector',
      name,
      synthetic: true,
    })

  it('a connected connector reaches NO agent until one is granted it', () => {
    // THE RULE THE PICTURE MUST TELL THE TRUTH ABOUT. Connecting makes a
    // connector available and gives it to nobody. Drawing it on every ring said
    // the opposite, and it said it about a permission the agent did not have.
    const records = [connected('notion'), connected('linear')]
    const out = groupAgentCapabilities(
      records,
      new Map([
        ['a1', 'openclaw'],
        ['a2', 'clawboo-native'],
        ['a3', 'codex'],
      ]),
    )
    for (const id of ['a1', 'a2', 'a3']) {
      expect((out.get(id) ?? []).map((r) => r.name)).toEqual([])
    }
  })

  it('reaches exactly the agent that was granted it, whatever its runtime', () => {
    const records = [connected('notion'), granted('notion', 'openclaw-1')]
    const out = groupAgentCapabilities(
      records,
      new Map([
        ['openclaw-1', 'openclaw'],
        ['other-1', 'openclaw'],
      ]),
    )
    expect((out.get('openclaw-1') ?? []).map((r) => r.name)).toEqual(['notion'])
    expect((out.get('other-1') ?? []).map((r) => r.name)).toEqual([])
  })

  it('sits alongside an agent that already has its own caps', () => {
    const records = [
      cap({ scope: 'agent', agentId: 'a1', runtime: 'openclaw', name: 'own skill' }),
      connected('linear'),
      granted('linear', 'a1'),
    ]
    const out = groupAgentCapabilities(records, new Map([['a1', 'openclaw']]))
    expect((out.get('a1') ?? []).map((r) => r.name).sort()).toEqual(['linear', 'own skill'])
  })

  it('ignores agents absent from the runtime map + empty agents with no global to inherit', () => {
    const records = [cap({ scope: 'agent', agentId: 'ghost', runtime: 'hermes', name: 's' })]
    const out = groupAgentCapabilities(records, new Map([['live', 'hermes']]))
    expect(out.has('ghost')).toBe(false) // has a record but isn't in the map
    expect(out.has('live')).toBe(false) // in the map but no own caps + no hermes global
  })
})
