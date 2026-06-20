// Observability panel. The test asserts render + open-a-trace. Covers (a) the
// four mount fetches → sections render; (b) clicking a trace → GET
// /api/obs/traces/:id → detail; (c) non-ok fetches → honest empty sections (no
// error UI). The 5 s poll never fires sub-second; cleanup() clears it.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ObsPanel, spanDepths } from '../ObsPanel'

const TRACE_EVENT = {
  seq: 1,
  ts: 1_700_000_000_000,
  kind: 'span_start',
  taskId: 't1',
  agentId: 'a1',
  runtime: 'openclaw',
  traceId: 'trace-abc',
  spanId: 's1',
  parentSpanId: null,
  data: '{"name":"run task"}',
}

function obsHandlers(events: unknown[] = []) {
  return [
    http.get('/api/obs/health', () => HttpResponse.json({ agents: [] })),
    http.get('/api/obs/events', () => HttpResponse.json({ events })),
    http.get('/api/obs/errors', () => HttpResponse.json({ errors: [], harnessBugCount: 0 })),
    http.get('/api/obs/graph', () =>
      HttpResponse.json({ tasks: [], taskEdges: [], agents: [], agentEdges: [] }),
    ),
  ]
}

afterEach(() => cleanup())

describe('ObsPanel', () => {
  it('renders the obs sections + a trace item from the event log', async () => {
    server.use(...obsHandlers([TRACE_EVENT]))
    render(<ObsPanel />)

    expect(await screen.findByTestId('obs-panel')).toBeInTheDocument()
    expect(screen.getByTestId('obs-traces-list')).toBeInTheDocument()
    expect(screen.getByTestId('obs-error-taxonomy')).toBeInTheDocument()
    expect(await screen.findByTestId('obs-trace-item')).toBeInTheDocument()
    // Obs hosts its own inline GitHub Star pill (so the global AppTopBar is
    // suppressed for it → exactly one Star, no disconnected top strip).
    expect(screen.getByTestId('github-star-button')).toBeInTheDocument()
  })

  it('opens a trace → renders the single-trace detail', async () => {
    server.use(
      ...obsHandlers([TRACE_EVENT]),
      http.get('/api/obs/traces/:id', () =>
        HttpResponse.json({
          traceId: 'trace-abc',
          events: [TRACE_EVENT],
          metrics: {
            totalCostUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            toolErrorRate: 0,
            toolCalls: 0,
            toolErrors: 0,
            activeAgents: 1,
            tokensPerMinute: 0,
          },
        }),
      ),
    )
    const user = userEvent.setup()
    render(<ObsPanel />)

    await user.click(await screen.findByTestId('obs-trace-item'))
    expect(await screen.findByTestId('obs-trace-detail')).toBeInTheDocument()
  })

  it('renders honest empty sections when the obs fetches are not ok', async () => {
    server.use(
      http.get('/api/obs/health', () => new HttpResponse(null, { status: 500 })),
      http.get('/api/obs/events', () => new HttpResponse(null, { status: 500 })),
      http.get('/api/obs/errors', () => new HttpResponse(null, { status: 500 })),
      http.get('/api/obs/graph', () => new HttpResponse(null, { status: 500 })),
    )
    render(<ObsPanel />)

    expect(await screen.findByTestId('obs-panel')).toBeInTheDocument()
    // Empty states render via the branded <EmptyState> primitive (title + helper).
    expect(screen.getByText('No traces yet')).toBeInTheDocument()
    expect(screen.getByText('No active agents')).toBeInTheDocument()
  })
})

describe('spanDepths (cycle-safe)', () => {
  const span = (seq: number, spanId: string, parentSpanId: string | null) => ({
    seq,
    ts: 0,
    kind: 'span_start',
    taskId: null,
    agentId: null,
    runtime: null,
    traceId: 't',
    spanId,
    parentSpanId,
    data: '{}',
  })

  it('does not infinite-recurse (stack overflow) on a cyclic parentSpanId chain', () => {
    // A→B→A would overflow the stack in the naive recursion (cache.set runs only
    // AFTER the recursive call, so neither span is cached before it is revisited).
    const events = [span(1, 'A', 'B'), span(2, 'B', 'A')]
    expect(() => spanDepths(events)).not.toThrow()
    const depths = spanDepths(events)
    expect(Number.isFinite(depths.get(1))).toBe(true)
    expect(Number.isFinite(depths.get(2))).toBe(true)
  })

  it('computes correct depths for an acyclic chain', () => {
    const events = [span(1, 'root', null), span(2, 'child', 'root'), span(3, 'grand', 'child')]
    const depths = spanDepths(events)
    expect(depths.get(1)).toBe(0)
    expect(depths.get(2)).toBe(1)
    expect(depths.get(3)).toBe(2)
  })
})
