import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useToastStore } from '@/stores/toast'
import { confirm } from '@/stores/confirm'
import {
  RuntimeDiagnosticsDrawer,
  type RuntimeDiagnosticsTarget,
} from '../RuntimeDiagnosticsDrawer'

// The design-system confirm() (replaces window.confirm) is mocked so these unit
// tests drive the disconnect flow without rendering the app-root <ConfirmDialog>.
vi.mock('@/stores/confirm', async (orig) => ({
  ...(await orig<typeof import('@/stores/confirm')>()),
  confirm: vi.fn(),
}))

afterEach(() => {
  vi.mocked(confirm).mockReset()
  cleanup()
})

beforeEach(() => {
  server.use(
    http.get('/api/obs/errors', () => HttpResponse.json({ errors: [] })),
    http.get('/api/capabilities', () => HttpResponse.json({ records: [], sources: [] })),
  )
})

const noop = (): void => {}

function target(over: Partial<RuntimeDiagnosticsTarget>): RuntimeDiagnosticsTarget {
  return {
    id: 'x',
    name: 'X',
    runtimeClass: 'wrapped-oneshot',
    statusTone: 'idle',
    statusLabel: 'Unknown',
    health: { ok: false },
    ...over,
  }
}

describe('RuntimeDiagnosticsDrawer', () => {
  it('OpenClaw → connected-substrate badge + Gateway/channels facts', async () => {
    render(
      <RuntimeDiagnosticsDrawer
        target={target({
          id: 'openclaw',
          name: 'OpenClaw',
          runtimeClass: 'connected-substrate',
          statusTone: 'success',
          statusLabel: 'Connected',
          health: { ok: true },
          gatewayUrl: 'ws://localhost:18789',
          connectionStatus: 'connected',
        })}
        onClose={noop}
        onRecheck={noop}
      />,
    )
    expect(await screen.findByTestId('runtime-diagnostics-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-depth-badge')).toHaveTextContent(/connected substrate/i)
    expect(screen.getByText('ws://localhost:18789')).toBeInTheDocument()
    expect(screen.getByText(/native to OpenClaw/i)).toBeInTheDocument()
  })

  it('native → native-peer badge + provider/model facts', async () => {
    render(
      <RuntimeDiagnosticsDrawer
        target={target({
          id: 'clawboo-native',
          name: 'Clawboo Native',
          runtimeClass: 'native',
          envVar: 'ANTHROPIC_API_KEY',
          hasCredential: true,
          models: ['claude-haiku-4-5'],
          contextWindowTokens: 200000,
        })}
        onClose={noop}
        onRecheck={noop}
      />,
    )
    expect(await screen.findByTestId('runtime-diagnostics-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-depth-badge')).toHaveTextContent(/native peer/i)
    expect(screen.getByText('claude-haiku-4-5')).toBeInTheDocument()
  })

  it('Hermes → wrapped-oneshot badge + skills count + self-improvement', async () => {
    server.use(
      http.get('/api/capabilities', () =>
        HttpResponse.json({ records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], sources: [] }),
      ),
    )
    render(
      <RuntimeDiagnosticsDrawer
        target={target({
          id: 'hermes',
          name: 'Hermes',
          runtimeClass: 'wrapped-oneshot',
          installed: true,
          binPath: '/usr/local/bin/hermes',
          nativeHome: { scope: 'per-identity', persist: true },
        })}
        onClose={noop}
        onRecheck={noop}
      />,
    )
    expect(await screen.findByTestId('runtime-diagnostics-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-depth-badge')).toHaveTextContent(/wrapped one-shot/i)
    expect(screen.getByText(/managed by Hermes/i)).toBeInTheDocument()
    expect(await screen.findByText('3')).toBeInTheDocument() // skills count
  })

  it('shows credential PRESENCE (env-var name) — never a value (leak guard)', async () => {
    const SECRET = 'sk-ant-LEAK-CANARY-zzz'
    render(
      <RuntimeDiagnosticsDrawer
        target={target({
          id: 'claude-code',
          name: 'Claude Code',
          runtimeClass: 'wrapped-oneshot',
          authKind: 'api-key',
          envVar: 'ANTHROPIC_API_KEY',
          hasCredential: true,
        })}
        onClose={noop}
        onRecheck={noop}
      />,
    )
    expect(await screen.findByTestId('runtime-diagnostics-drawer')).toBeInTheDocument()
    expect(screen.getAllByText('ANTHROPIC_API_KEY').length).toBeGreaterThan(0)
    // The target interface carries no secret value by construction — assert no leak.
    expect(document.body.textContent ?? '').not.toContain(SECRET)
  })

  it('Disconnect confirms before clearing the credential, then re-checks', async () => {
    let disconnected = 0
    let rechecked = 0
    server.use(
      http.post('/api/runtimes/claude-code/disconnect', () => {
        disconnected += 1
        return HttpResponse.json({ ok: true })
      }),
    )
    vi.mocked(confirm).mockResolvedValue(false)
    const user = userEvent.setup()
    render(
      <RuntimeDiagnosticsDrawer
        target={target({
          id: 'claude-code',
          name: 'Claude Code',
          authKind: 'api-key',
          connectionState: 'ready',
          hasCredential: true,
        })}
        onClose={noop}
        onRecheck={() => {
          rechecked += 1
        }}
      />,
    )
    const btn = await screen.findByTestId('runtime-diagnostics-disconnect')

    // Cancelled at the confirm → nothing happens.
    await user.click(btn)
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(disconnected).toBe(0)
    expect(rechecked).toBe(0)

    // Confirmed → POSTs + re-checks.
    vi.mocked(confirm).mockResolvedValue(true)
    await user.click(btn)
    await waitFor(() => expect(disconnected).toBe(1))
    await waitFor(() => expect(rechecked).toBe(1))
  })

  it('a failed Disconnect surfaces an error toast and does NOT re-check', async () => {
    let rechecked = 0
    server.use(
      http.post('/api/runtimes/claude-code/disconnect', () =>
        HttpResponse.json({ ok: false, error: 'vault is locked' }, { status: 500 }),
      ),
    )
    vi.mocked(confirm).mockResolvedValue(true)
    const user = userEvent.setup()
    render(
      <RuntimeDiagnosticsDrawer
        target={target({
          id: 'claude-code',
          name: 'Claude Code',
          authKind: 'api-key',
          connectionState: 'ready',
          hasCredential: true,
        })}
        onClose={noop}
        onRecheck={() => {
          rechecked += 1
        }}
      />,
    )
    await user.click(await screen.findByTestId('runtime-diagnostics-disconnect'))
    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /vault is locked/.test(t.message)),
      ).toBe(true),
    )
    expect(rechecked).toBe(0)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(
      <RuntimeDiagnosticsDrawer
        target={target({
          id: 'openclaw',
          name: 'OpenClaw',
          runtimeClass: 'connected-substrate',
          statusTone: 'success',
          statusLabel: 'Connected',
          health: { ok: true },
          docsUrl: 'https://example.com',
        })}
        onClose={noop}
        onRecheck={noop}
      />,
    )
    await screen.findByTestId('runtime-diagnostics-drawer')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
