// OpenClawSetupFlow — the dashboard host that drives the OpenClaw setup mini
// state machine (detect → install → configure → startGateway) and finalizes via
// enterGatewayMode. The four onboarding steps + the connect/finalize helpers are
// MOCKED so this test isolates the host's wiring/state-machine from SSE/WS.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { connectGatewayFromSettings, enterGatewayMode } = vi.hoisted(() => ({
  connectGatewayFromSettings: vi.fn(),
  enterGatewayMode: vi.fn(),
}))

vi.mock('@/lib/gatewayConnect', () => ({ connectGatewayFromSettings }))
vi.mock('@/features/connection/GatewayBootstrap', () => ({ enterGatewayMode }))

vi.mock('@/features/onboarding/steps', () => ({
  DetectStep: (p: {
    onAllGood: () => void
    onNeedInstall: () => void
    onNeedConfigure: () => void
    onNeedGateway: () => void
    onAdvancedConnect: () => void
  }) => (
    <div data-testid="mock-detect">
      <button data-testid="d-allgood" onClick={p.onAllGood}>
        allgood
      </button>
      <button data-testid="d-install" onClick={p.onNeedInstall}>
        install
      </button>
      <button data-testid="d-configure" onClick={p.onNeedConfigure}>
        configure
      </button>
      <button data-testid="d-gateway" onClick={p.onNeedGateway}>
        gateway
      </button>
      <button data-testid="d-advanced" onClick={p.onAdvancedConnect}>
        advanced
      </button>
    </div>
  ),
  InstallStep: (p: { onInstalled: (v: string) => void; onBack: () => void }) => (
    <div data-testid="mock-install">
      <button data-testid="i-installed" onClick={() => p.onInstalled('1.0.0')}>
        installed
      </button>
      <button data-testid="i-back" onClick={p.onBack}>
        back
      </button>
    </div>
  ),
  ConfigureStep: (p: { onConfigured: (d: { gatewayUrl: string }) => void; onBack: () => void }) => (
    <div data-testid="mock-configure">
      <button data-testid="c-configured" onClick={() => p.onConfigured({ gatewayUrl: 'ws://configured:9999' })}>
        configured
      </button>
      <button data-testid="c-back" onClick={p.onBack}>
        back
      </button>
    </div>
  ),
  StartGatewayStep: (p: { onStarted: (c: unknown) => void; onBack: () => void }) => (
    <div data-testid="mock-startgateway">
      <button data-testid="s-started" onClick={() => p.onStarted({ id: 'client' })}>
        started
      </button>
      <button data-testid="s-back" onClick={p.onBack}>
        back
      </button>
    </div>
  ),
}))

import { OpenClawSetupFlow } from '../OpenClawSetupFlow'

beforeEach(() => {
  connectGatewayFromSettings.mockReset()
  enterGatewayMode.mockReset()
  enterGatewayMode.mockResolvedValue(undefined)
})
afterEach(() => cleanup())

describe('OpenClawSetupFlow', () => {
  it('walks detect → install → configure → startGateway, then finalizes on onStarted', async () => {
    const onClose = vi.fn()
    render(<OpenClawSetupFlow onClose={onClose} />)
    expect(screen.getByTestId('mock-detect')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('d-install'))
    expect(screen.getByTestId('mock-install')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('i-installed'))
    expect(screen.getByTestId('mock-configure')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('c-configured'))
    expect(screen.getByTestId('mock-startgateway')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('s-started'))
    // The url captured from ConfigureStep is threaded into the finalizer.
    await waitFor(() =>
      expect(enterGatewayMode).toHaveBeenCalledWith({ id: 'client' }, 'ws://configured:9999'),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('onNeedGateway → startGateway falls back to the default url when configure was skipped', async () => {
    const onClose = vi.fn()
    render(<OpenClawSetupFlow onClose={onClose} />)
    fireEvent.click(screen.getByTestId('d-gateway'))
    expect(screen.getByTestId('mock-startgateway')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('s-started'))
    await waitFor(() =>
      expect(enterGatewayMode).toHaveBeenCalledWith({ id: 'client' }, 'ws://localhost:18789'),
    )
  })

  it('onAllGood: connects via saved settings, finalizes, and closes', async () => {
    const onClose = vi.fn()
    connectGatewayFromSettings.mockResolvedValue({
      client: { id: 'c' },
      gatewayUrl: 'ws://localhost:18789',
    })
    render(<OpenClawSetupFlow onClose={onClose} />)

    fireEvent.click(screen.getByTestId('d-allgood'))
    await waitFor(() =>
      expect(enterGatewayMode).toHaveBeenCalledWith({ id: 'c' }, 'ws://localhost:18789'),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('onAllGood failure (e.g. NOT_PAIRED) routes to startGateway instead of closing', async () => {
    const onClose = vi.fn()
    connectGatewayFromSettings.mockRejectedValue(new Error('NOT_PAIRED'))
    render(<OpenClawSetupFlow onClose={onClose} />)

    fireEvent.click(screen.getByTestId('d-allgood'))
    await waitFor(() => expect(screen.getByTestId('mock-startgateway')).toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
    expect(enterGatewayMode).not.toHaveBeenCalled()
  })

  it('the close affordance calls onClose', () => {
    const onClose = vi.fn()
    render(<OpenClawSetupFlow onClose={onClose} />)
    fireEvent.click(screen.getByTestId('openclaw-setup-close'))
    expect(onClose).toHaveBeenCalled()
  })
})
