// RuntimeConnectList — the redesigned connected CARD: a small "Connected" status
// top-right + a Manage footer button that expands the inline management body
// (the ChatGPT-subscription option, Disconnect, Details). Prop-driven (no fetch
// on render); RTL + jest-dom + userEvent.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeStatus } from '@clawboo/control-client'

import { RuntimeConnectList, type OpenClawTabConfig } from '../RuntimeConnectList'

afterEach(() => cleanup())

const OPENCLAW_OFF: OpenClawTabConfig = {
  connected: false,
  statusLabel: 'Unavailable',
  setupTestId: 'runtime-openclaw-setup',
}

function renderList(statuses: RuntimeStatus[], openclaw: OpenClawTabConfig = OPENCLAW_OFF) {
  return render(
    <RuntimeConnectList
      runtimeIds={['hermes']}
      statuses={statuses}
      loaded
      variant="panel"
      onChanged={vi.fn()}
      onDiagnostics={vi.fn()}
      openclaw={openclaw}
    />,
  )
}

describe('RuntimeConnectList — OpenClaw offline vs fresh', () => {
  it('a previously-configured but offline OpenClaw reads "Disconnected · Reconnect", not "Set up"', () => {
    renderList([], {
      connected: false,
      configured: true,
      statusLabel: 'Offline',
      setupTestId: 'runtime-openclaw-setup',
    })
    const toggle = screen.getByTestId('runtime-list-row-openclaw-toggle')
    expect(toggle).toHaveTextContent(/Reconnect/i)
    expect(toggle).not.toHaveTextContent(/Set up/i)
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
  })

  it('a never-configured OpenClaw reads "Set up" (no Disconnected chip)', () => {
    renderList([], {
      connected: false,
      configured: false,
      statusLabel: 'Unavailable',
      setupTestId: 'runtime-openclaw-setup',
    })
    expect(screen.getByTestId('runtime-list-row-openclaw-toggle')).toHaveTextContent(/Set up/i)
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument()
  })
})

describe('RuntimeConnectList — connected card + Manage', () => {
  it('a connected runtime shows the top-right "Connected" status + a Manage footer (no ⓘ button)', async () => {
    renderList([{ id: 'hermes', connectionState: 'ready', codexAuth: false }])
    expect(screen.getByText('Connected')).toBeInTheDocument()
    const manage = screen.getByTestId('runtime-list-row-hermes-toggle')
    expect(manage).toHaveTextContent(/Manage/i)
    // The old ⓘ diagnostics button is gone from the header.
    expect(screen.queryByTestId('runtime-hermes-diagnostics')).not.toBeInTheDocument()
    // Manage toggles the inline body.
    expect(manage).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(manage)
    expect(manage).toHaveAttribute('aria-expanded', 'true')
  })

  it('Manage hosts the ChatGPT-subscription sign-in (a provider row) when Codex is connected and Hermes lacks it', async () => {
    renderList([
      { id: 'hermes', connectionState: 'ready', codexAuth: false },
      { id: 'codex', connectionState: 'ready' },
    ])
    expect(screen.getByTestId('runtime-hermes-manage')).toBeInTheDocument()
    // The subscription is now a row inside the providers list (async load).
    expect(await screen.findByTestId('runtime-hermes-subscription-add')).toBeInTheDocument()
    expect(screen.getByTestId('chatgpt-signin-hermes-start')).toBeInTheDocument()
    // Disconnect + Details live in the same Manage body.
    expect(screen.getByTestId('runtime-hermes-disconnect')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-hermes-details')).toBeInTheDocument()
  })

  it('Manage shows the subscription CONFIRMATION (not the sign-in) once Hermes has it', async () => {
    renderList([
      { id: 'hermes', connectionState: 'ready', codexAuth: true },
      { id: 'codex', connectionState: 'ready' },
    ])
    expect(await screen.findByTestId('runtime-hermes-subscription-connected')).toBeInTheDocument()
    expect(screen.queryByTestId('chatgpt-signin-hermes-start')).not.toBeInTheDocument()
  })

  it('with Codex NOT connected, Manage shows the "connect Codex first" hint (no sign-in)', async () => {
    renderList([{ id: 'hermes', connectionState: 'ready', codexAuth: false }])
    expect(await screen.findByTestId('runtime-hermes-subscription-needs-codex')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-hermes-subscription-add')).not.toBeInTheDocument()
    expect(screen.queryByTestId('chatgpt-signin-hermes-start')).not.toBeInTheDocument()
  })

  it('the connected OpenClaw Manage carries the subscription as a provider row + gateway + default model', async () => {
    renderList([{ id: 'codex', connectionState: 'ready' }], {
      connected: true,
      statusLabel: 'Healthy',
      setupTestId: 'runtime-openclaw-setup',
      subscriptionConnected: false,
      codexReady: true,
      onDiagnostics: vi.fn(),
      extra: <div data-testid="mcp-attach-stub">MCP config</div>,
    })
    expect(screen.getByTestId('runtime-list-row-openclaw-toggle')).toHaveTextContent(/Manage/i)
    expect(screen.getByTestId('mcp-attach-stub')).toBeInTheDocument()
    // The Gateway process controls + the OpenClaw default-model picker moved here
    // from the System panel (this runtime's home now).
    expect(screen.getByTestId('openclaw-gateway-section')).toBeInTheDocument()
    expect(await screen.findByTestId('openclaw-default-model')).toBeInTheDocument()
    // The ChatGPT subscription is a peer row in the providers list (async load).
    expect(await screen.findByTestId('runtime-openclaw-subscription-add')).toBeInTheDocument()
    // OpenClaw's Disconnect (stops the gateway) + Details are present too.
    expect(screen.getByTestId('runtime-openclaw-disconnect')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-openclaw-details')).toBeInTheDocument()
  })

  it('Details opens the diagnostics drawer via onDiagnostics', async () => {
    const onDiagnostics = vi.fn()
    render(
      <RuntimeConnectList
        runtimeIds={['hermes']}
        statuses={[{ id: 'hermes', connectionState: 'ready', codexAuth: false }]}
        loaded
        variant="panel"
        onChanged={vi.fn()}
        onDiagnostics={onDiagnostics}
        openclaw={OPENCLAW_OFF}
      />,
    )
    await userEvent.click(screen.getByTestId('runtime-hermes-details'))
    expect(onDiagnostics).toHaveBeenCalledWith('hermes')
  })
})
