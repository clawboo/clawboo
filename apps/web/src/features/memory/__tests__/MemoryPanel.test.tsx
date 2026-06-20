// Memory browser: render of browse/provider on mount + a search round-trip.

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
    createdAt: 0,
    updatedAt: 0,
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
