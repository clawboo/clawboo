// Runtimes panel — the connection MANAGER. It renders the shared connect LIST
// (variant "panel"): the synthesized OpenClaw row plus the four non-OpenClaw
// runtimes (incl. the built-in native), status-driven from GET /api/runtimes
// (falling back to a Connect CTA when the fetch is not ok). Each row carries a
// diagnostics button (Re-check + Disconnect live in the drawer); connected rows
// show the premium indicator, unconnected rows an explicit CTA. RTL pattern (msw
// onUnhandledRequest: 'error'). The 8 s poll never fires in a sub-second test.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { useConnectionStore } from '@/stores/connection'

import { server } from '../../../__vitest__/mswServer'
import { RuntimesPanel } from '../RuntimesPanel'

// A truthy stub for a live OpenClaw Gateway client (the OpenClaw row is "connected"
// only when a real client is present, not merely when the app status is connected —
// native mode is app-connected with a null client).
const stubClient = {} as unknown as GatewayClient

beforeEach(() => {
  useConnectionStore.setState({ status: 'disconnected', client: null })
  // The OpenClaw row now also polls the server's registry health for thin-client
  // parity. Default it to disconnected so the browser-client assertions below are
  // unchanged; individual tests override it to prove the server-side signal.
  server.use(
    http.get('/api/agents/registry/health', () =>
      HttpResponse.json({ ok: false, connection: 'disconnected', lastSyncedAt: null }),
    ),
  )
})
afterEach(() => cleanup())

describe('RuntimesPanel', () => {
  it('renders OpenClaw + all four runtime rows (status from GET /api/runtimes)', async () => {
    useConnectionStore.setState({ status: 'connected', client: stubClient })
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

    expect(await screen.findByTestId('runtime-list-row-openclaw')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-clawboo-native')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-codex')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-hermes')).toBeInTheDocument()
    // Connected claude-code settles to the premium indicator (the visible label +
    // its live region both carry the text); the built-in native (needs a key)
    // shows an explicit Connect CTA, never Install (it ships in the server).
    expect((await screen.findAllByText('Connected')).length).toBeGreaterThan(0)
    expect(await screen.findByTestId('runtime-list-row-clawboo-native-toggle')).toHaveAccessibleName(
      /connect clawboo native/i,
    )
    expect(screen.queryByTestId('runtime-clawboo-native-install')).not.toBeInTheDocument()
  })

  it('renders rows from the catalog even when /api/runtimes is not ok', async () => {
    server.use(http.get('/api/runtimes', () => new HttpResponse(null, { status: 500 })))
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw')).toBeInTheDocument()
    // Rows still render (status unknown → a Connect CTA once the fetch settles),
    // never a blank panel.
    expect(await screen.findByTestId('runtime-list-row-clawboo-native-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-hermes')).toBeInTheDocument()
  })

  it('shows the "Set up OpenClaw" CTA on the OpenClaw row when NOT connected', async () => {
    useConnectionStore.setState({ status: 'disconnected', client: null })
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)

    const toggle = await screen.findByTestId('runtime-list-row-openclaw-toggle')
    expect(toggle).toHaveAccessibleName(/set up openclaw/i)
    expect(screen.getByTestId('runtime-openclaw-setup')).toBeInTheDocument()
  })

  it('shows the CTA in NATIVE mode (app connected, but no OpenClaw client) — the P7 target', async () => {
    // Native-first user: the app is 'connected' via clawboo-native with a null
    // Gateway client. OpenClaw itself is NOT connected → the CTA must show.
    useConnectionStore.setState({ status: 'connected', client: null })
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw-toggle')).toHaveAccessibleName(
      /set up openclaw/i,
    )
    expect(screen.getByTestId('runtime-openclaw-setup')).toBeInTheDocument()
  })

  it('hides the "Set up OpenClaw" CTA once OpenClaw is connected (a live client)', async () => {
    useConnectionStore.setState({ status: 'connected', client: stubClient })
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw')).toBeInTheDocument()
    // Connected → the premium indicator + a Manage toggle, no setup button.
    expect(screen.queryByTestId('runtime-openclaw-setup')).not.toBeInTheDocument()
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
  })

  it('reads OpenClaw as connected from the server registry health with NO browser client (thin-client parity)', async () => {
    // Thin client: app connected via clawboo-native (null Gateway client), but the
    // server's OpenClaw operator connection is live → OpenClaw reads connected and
    // the CTA hides, even with no browser Gateway WS.
    useConnectionStore.setState({ status: 'connected', client: null })
    server.use(
      http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
      http.get('/api/agents/registry/health', () =>
        HttpResponse.json({ ok: true, connection: 'connected', lastSyncedAt: 1 }),
      ),
    )
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('runtime-openclaw-setup')).not.toBeInTheDocument(),
    )
  })

  it('every row exposes a diagnostics button (no tab switch needed)', async () => {
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)
    // Native's diagnostics are reachable directly on its row.
    expect(await screen.findByTestId('runtime-clawboo-native-diagnostics')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-openclaw-diagnostics')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-claude-code-diagnostics')).toBeInTheDocument()
  })

  it('the OpenClaw row carries setup + diagnostics + the MCP attach config', async () => {
    useConnectionStore.setState({ status: 'disconnected', client: null })
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)
    // Diagnostics is on the row itself; expanding the row reveals setup + MCP.
    expect(await screen.findByTestId('runtime-openclaw-diagnostics')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('runtime-list-row-openclaw-toggle'))
    expect(screen.getByTestId('runtime-openclaw-setup')).toBeInTheDocument()
    expect(screen.getByText('MCP attach config')).toBeInTheDocument()
  })
})
