// Memory browser: render of browse/provider on mount + a search round-trip,
// plus the learning overlay surfacing (pills, feedback loop, provenance).

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { MemoryPanel } from '../MemoryPanel'

function fact(id: string, title: string) {
  return {
    id,
    title,
    content: `${title} body`,
    tags: [],
    scopeAgentId: null,
    scopeTeamId: null,
    tenantId: null,
    createdByAgentId: null,
    createdByRuntime: null,
    sourceTaskId: null,
    sourceSessionKey: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function learningEntry(status: string | null, extra: Record<string, unknown> = {}) {
  return {
    status,
    score: 0.5,
    uses: 1,
    usefulCount: 1,
    negativeCount: 0,
    lastUsedAt: 1,
    recentTrail: [],
    ...extra,
  }
}

afterEach(() => cleanup())

describe('MemoryPanel', () => {
  it('renders the panel + browse facts/provider on mount', async () => {
    server.use(
      http.get('/api/memory/browse', () =>
        HttpResponse.json({ facts: [fact('f1', 'Fact one')], procedures: [] }),
      ),
      http.get('/api/memory/provider', () =>
        HttpResponse.json({ provider: { id: 'ollama', dimensions: 768 } }),
      ),
    )
    render(<MemoryPanel />)

    expect(await screen.findByTestId('memory-panel')).toBeInTheDocument()
    expect(await screen.findByText('Fact one')).toBeInTheDocument()
  })

  it('shows the one-shared-memory framing + per-fact scope badges', async () => {
    server.use(
      http.get('/api/memory/browse', () =>
        HttpResponse.json({
          facts: [
            { ...fact('team', 'Team fact'), scopeTeamId: 't1', scopeAgentId: null },
            { ...fact('agent', 'Agent fact'), scopeTeamId: 't1', scopeAgentId: 'a1' },
          ],
          procedures: [],
        }),
      ),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
    )
    render(<MemoryPanel />)

    expect(await screen.findByTestId('memory-shared-banner')).toBeInTheDocument()
    // Per-runtime private indicator (read-only).
    expect(screen.getByText(/Private self-models/i)).toBeInTheDocument()
    // Scope badges differentiate team-shared vs agent-scoped.
    expect(await screen.findByText('Team fact')).toBeInTheDocument()
    expect(screen.getByText(/Team-shared/i)).toBeInTheDocument()
    expect(screen.getByText(/Agent-scoped/i)).toBeInTheDocument()
  })

  it('searches and renders results', async () => {
    server.use(
      http.get('/api/memory/browse', () => HttpResponse.json({ facts: [], procedures: [] })),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
      http.get('/api/memory', () =>
        HttpResponse.json({
          results: [{ ...fact('r1', 'Match'), score: 0.9, matchedVia: 'hybrid' }],
        }),
      ),
    )
    const user = userEvent.setup()
    render(<MemoryPanel />)

    await screen.findByTestId('memory-panel')
    await user.type(screen.getByTestId('memory-search-input'), 'widget')
    await user.click(screen.getByTestId('memory-search-run'))

    expect(await screen.findByTestId('memory-result')).toBeInTheDocument()
    expect(screen.getByText('Match')).toBeInTheDocument()
  })

  it('shows an error + retry when the browse load fails (not a silent empty store)', async () => {
    server.use(
      http.get('/api/memory/browse', () => new HttpResponse(null, { status: 500 })),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
    )
    render(<MemoryPanel />)
    expect(await screen.findByTestId('memory-fetch-error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('renders learning pills from the browse learning map (contested carries the verify nudge)', async () => {
    server.use(
      http.get('/api/memory/browse', () =>
        HttpResponse.json({
          facts: [fact('f1', 'Preferred fact'), fact('f2', 'Contested fact')],
          procedures: [],
          learning: {
            f1: learningEntry('preferred', { usefulCount: 2 }),
            f2: learningEntry('contested', { verdict: 'avoid', negativeCount: 1 }),
          },
        }),
      ),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
    )
    render(<MemoryPanel />)

    expect(await screen.findByText('preferred')).toBeInTheDocument()
    expect(screen.getByText('contested · verify')).toBeInTheDocument()
  })

  it('cited-only facts show a subtle usage count instead of a pill', async () => {
    server.use(
      http.get('/api/memory/browse', () =>
        HttpResponse.json({
          facts: [fact('f1', 'Cited fact')],
          procedures: [],
          learning: { f1: learningEntry(null, { uses: 4, usefulCount: 0 }) },
        }),
      ),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
    )
    render(<MemoryPanel />)
    expect(await screen.findByText('used 4×')).toBeInTheDocument()
  })

  it('Helpful POSTs /api/memory/feedback and updates the pill from the returned entry', async () => {
    let postedBody: unknown = null
    server.use(
      http.get('/api/memory/browse', () =>
        HttpResponse.json({ facts: [fact('f1', 'Fact one')], procedures: [], learning: {} }),
      ),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
      http.post('/api/memory/feedback', async ({ request }) => {
        postedBody = await request.json()
        return HttpResponse.json({ ok: true, learning: learningEntry('tentative') })
      }),
    )
    const user = userEvent.setup()
    render(<MemoryPanel />)

    await screen.findByText('Fact one')
    expect(screen.queryByText('tentative')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('memory-fact-helpful'))

    expect(await screen.findByText('tentative')).toBeInTheDocument()
    expect(postedBody).toMatchObject({ factId: 'f1', outcome: 'useful' })
  })

  it('provenance caption renders non-null segments and omits nulls (old rows show nothing)', async () => {
    server.use(
      http.get('/api/memory/browse', () =>
        HttpResponse.json({
          facts: [
            { ...fact('f1', 'User fact'), createdByRuntime: 'user' },
            {
              ...fact('f2', 'Run fact'),
              createdByAgentId: 'agent-1234567890',
              createdByRuntime: 'clawboo-native',
              sourceTaskId: 'task-abcdef-123456',
            },
            fact('f3', 'Old fact'), // all-null provenance → no caption
          ],
          procedures: [],
          learning: {},
        }),
      ),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
    )
    render(<MemoryPanel />)

    await screen.findByText('User fact')
    const captions = screen.getAllByTestId('memory-provenance').map((el) => el.textContent)
    expect(captions).toHaveLength(2)
    expect(captions[0]).toBe('by user · user')
    // No fleet entry for the agent id → 8-char id fallback; task id sliced to 8.
    expect(captions[1]).toBe('by agent-12 · clawboo-native · task task-abc')
  })

  it('clicking a fact card expands its outcome trail', async () => {
    server.use(
      http.get('/api/memory/browse', () =>
        HttpResponse.json({
          facts: [fact('f1', 'Fact one')],
          procedures: [],
          learning: {
            f1: learningEntry('tentative', {
              recentTrail: [
                {
                  kind: 'useful',
                  createdAt: Date.now(),
                  agentId: 'scout',
                  taskId: null,
                  runtime: 'hermes',
                  note: null,
                },
              ],
            }),
          },
        }),
      ),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
    )
    const user = userEvent.setup()
    render(<MemoryPanel />)

    await screen.findByText('Fact one')
    expect(screen.queryByTestId('memory-fact-trail')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('memory-fact-card'))
    expect(await screen.findByTestId('memory-fact-trail')).toBeInTheDocument()
    expect(screen.getByTestId('memory-outcome-trail-item')).toHaveTextContent('useful')
  })

  it('surfaces an error toast when Save Fact fails (not a silent no-op)', async () => {
    useToastStore.setState({ toasts: [] })
    server.use(
      http.get('/api/memory/browse', () => HttpResponse.json({ facts: [], procedures: [] })),
      http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
      http.post('/api/memory', () => new HttpResponse(null, { status: 500 })),
    )
    const user = userEvent.setup()
    render(<MemoryPanel />)

    await screen.findByTestId('memory-panel')
    await user.type(screen.getByTestId('memory-fact-title'), 'A title')
    await user.type(screen.getByTestId('memory-fact-content'), 'Some content')
    await user.click(screen.getByTestId('memory-save-fact'))

    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => t.type === 'error' && /save/i.test(t.message)),
      ).toBe(true),
    )
  })
})
