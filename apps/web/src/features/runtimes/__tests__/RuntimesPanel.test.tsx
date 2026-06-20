// Runtimes panel — the connection MANAGER. The synthesized OpenClaw row is always
// present; the four non-OpenClaw runtimes (incl. the built-in native) always
// render as cards (status-driven from GET /api/runtimes, falling back to the
// catalog when the fetch is not ok). RTL pattern (msw onUnhandledRequest:
// 'error'). The 8 s poll never fires in a sub-second test; cleanup() clears it.

import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useConnectionStore } from '@/stores/connection'

import { server } from '../../../__vitest__/mswServer'
import { RuntimesPanel } from '../RuntimesPanel'

beforeEach(() => {
  useConnectionStore.setState({ status: 'disconnected' })
})
afterEach(() => cleanup())

describe('RuntimesPanel', () => {
  it('renders OpenClaw + all four runtime cards (status from GET /api/runtimes)', async () => {
    useConnectionStore.setState({ status: 'connected' })
    server.use(
      http.get('/api/runtimes', () =>
        HttpResponse.json({
          runtimes: [
            {
              id: 'claude-code',
              participantKind: 'agent',
              capabilities: { streaming: true, mcp: true, worktrees: true, resume: true },
              health: { ok: true },
              installed: true,
              authKind: 'api-key',
              connectionState: 'ready',
            },
            {
              id: 'clawboo-native',
              participantKind: 'agent',
              capabilities: {
                streaming: true,
                mcp: true,
                worktrees: true,
                resume: true,
                runtimeClass: 'native',
              },
              health: { ok: false },
              installed: true,
              binPath: null,
              builtIn: true,
              authKind: 'api-key',
              connectionState: 'needs-auth',
            },
          ],
          available: [],
        }),
      ),
    )
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-row-openclaw')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-row-clawboo-native')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-row-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-row-codex')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-row-hermes')).toBeInTheDocument()
    // Connected claude-code card shows the ready pill; the built-in native card
    // shows the paste-a-key state (never Install — it ships in the server).
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('Needs key')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-clawboo-native-install')).not.toBeInTheDocument()
  })

  it('renders cards from the catalog even when /api/runtimes is not ok', async () => {
    server.use(http.get('/api/runtimes', () => new HttpResponse(null, { status: 500 })))
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-row-openclaw')).toBeInTheDocument()
    // Cards still render (status undefined → unknown), never a blank panel.
    expect(screen.getByTestId('runtime-row-clawboo-native')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-row-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-row-hermes')).toBeInTheDocument()
  })
})
