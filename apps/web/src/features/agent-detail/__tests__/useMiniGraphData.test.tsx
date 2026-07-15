// @vitest-environment jsdom
//
// The MiniGraph must read the SAME unfiltered capability stream the Atlas reads.
// Regression guard for two bugs that made the agent-detail graph render bare for
// exactly the agents that depend on inheritance (codex / OpenClaw / a not-yet-run
// hermes), while native agents looked fine:
//
//   1. a server-side `?agentId=` filter drops every `scope:'global'` record
//      (they carry `agentId: null`, and the filter is `r.agentId !== f.agentId`),
//      so the inherit-if-empty fan-out had nothing to inherit; and
//   2. a `!client` gate skipped the fetch entirely in native / thin-client mode.

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchCapabilities = vi.fn()
const readAgentFile = vi.fn()

vi.mock('@/lib/capabilitiesClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/capabilitiesClient')>(
    '@/lib/capabilitiesClient',
  )
  return { ...actual, fetchCapabilities: (...a: unknown[]) => fetchCapabilities(...a) }
})
vi.mock('@clawboo/control-client', () => ({
  readAgentFile: (...a: unknown[]) => readAgentFile(...a),
}))
vi.mock('@/lib/openclawDefaultModel', () => ({ useOpenclawDefaultModel: () => null }))

import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'

import { useMiniGraphData } from '../useMiniGraphData'

const CODEX_AGENT: AgentState = {
  id: 'codex-1',
  name: 'Bug Fixer Boo',
  status: 'idle',
  sessionKey: null,
  model: null,
  createdAt: null,
  streamingText: null,
  runId: null,
  lastSeenAt: null,
  teamId: 't1',
  runtime: 'codex',
  execConfig: null,
}

// A codex agent owns NO agent-scoped caps — everything it shows is inherited
// from its runtime's shared `global` records.
const RECORDS = [
  {
    id: 'codex:mcp',
    sourceKey: 'mcp:clawboo-tasks',
    kind: 'connector',
    runtime: 'codex',
    scope: 'global',
    agentId: null,
    source: 'mcp-connector',
    manageability: 'external-write',
    name: 'clawboo-tasks',
    description: '',
    availability: null,
    available: true,
    diagnostics: [],
    provenance: null,
    status: 'ready',
    tenantId: null,
    syncedAt: '2026-01-01T00:00:00.000Z',
  },
]

beforeEach(() => {
  fetchCapabilities.mockReset()
  readAgentFile.mockReset()
  fetchCapabilities.mockResolvedValue({ records: RECORDS, sources: [], ok: true })
  readAgentFile.mockResolvedValue(null)
  useFleetStore.setState({ agents: [CODEX_AGENT] })
})
afterEach(() => {
  useConnectionStore.setState({ client: null })
})

describe('useMiniGraphData — reads the ONE unfiltered capability stream', () => {
  it('never filters by agentId (that would strip the inheritable `global` records)', async () => {
    renderHook(() => useMiniGraphData('codex-1'))
    await waitFor(() => expect(fetchCapabilities).toHaveBeenCalled())

    // Called with NO filter — a `{ agentId }` arg is the bug.
    const arg = fetchCapabilities.mock.calls[0]?.[0]
    expect(arg === undefined || (arg as { agentId?: string })?.agentId === undefined).toBe(true)
  })

  it('renders inherited capabilities in NATIVE mode (client === null — not gated)', async () => {
    useConnectionStore.setState({ client: null })
    const { result } = renderHook(() => useMiniGraphData('codex-1'))

    await waitFor(() => expect(result.current.nodes.length).toBeGreaterThan(0))
    // The inherited codex MCP connector became a real resource node.
    const connector = result.current.nodes.find((n) => n.type === 'resource')
    expect(connector).toBeDefined()
  })
})
