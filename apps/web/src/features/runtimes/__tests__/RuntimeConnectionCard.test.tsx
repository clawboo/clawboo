// RuntimeConnectionCard — the shared connection state machine. RTL pattern:
// msw (onUnhandledRequest:'error') + jest-dom + userEvent. The card starts at
// the server's connectionState; there is no flag-flip "available → Add" step.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeStatus } from '@clawboo/control-client'

import { server } from '../../../__vitest__/mswServer'
import { confirm } from '@/stores/confirm'
import { RuntimeConnectionCard } from '../RuntimeConnectionCard'
import { RUNTIME_CATALOG } from '../runtimeCatalog'

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

describe('RuntimeConnectionCard', () => {
  it('not-installed → Install streams SSE → onChanged', async () => {
    const onChanged = vi.fn()
    server.use(
      http.post(
        '/api/runtimes/claude-code/install',
        () =>
          new HttpResponse(
            'data: {"type":"output","line":"installing…"}\n\ndata: {"type":"complete","success":true}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    )
    const status: RuntimeStatus = { id: 'claude-code', connectionState: 'not-installed' }
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['claude-code']}
        status={status}
        variant="panel"
        onChanged={onChanged}
      />,
    )
    await userEvent.click(screen.getByTestId('runtime-claude-code-install'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('needs-auth → paste key → Connect POSTs the apiKey → onChanged', async () => {
    const onChanged = vi.fn()
    let captured: unknown = null
    server.use(
      http.post('/api/runtimes/hermes/connect', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
    )
    const status: RuntimeStatus = {
      id: 'hermes',
      connectionState: 'needs-auth',
      authKind: 'api-key',
      envVar: 'OPENROUTER_API_KEY',
    }
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['hermes']}
        status={status}
        variant="panel"
        onChanged={onChanged}
      />,
    )
    // The needs-auth state surfaces a "Get a key" link to the provider console.
    expect(screen.getByTestId('runtime-hermes-get-key').getAttribute('href')).toContain(
      'openrouter.ai',
    )
    await userEvent.type(screen.getByTestId('runtime-hermes-key'), 'sk-or-test')
    await userEvent.click(screen.getByTestId('runtime-hermes-connect'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(captured).toEqual({ apiKey: 'sk-or-test' })
  })

  it('needs-login (codex): shows the login command + Re-check', async () => {
    const onChanged = vi.fn()
    const status: RuntimeStatus = { id: 'codex', connectionState: 'needs-login' }
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['codex']}
        status={status}
        variant="panel"
        onChanged={onChanged}
      />,
    )
    expect(screen.getByText('codex login')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-codex-key')).not.toBeInTheDocument() // no key field for oauth
    await userEvent.click(screen.getByTestId('runtime-codex-recheck'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('ready (panel): Disconnect confirms, POSTs, then onChanged', async () => {
    const onChanged = vi.fn()
    vi.mocked(confirm).mockResolvedValue(true)
    server.use(
      http.post('/api/runtimes/hermes/disconnect', () =>
        HttpResponse.json({ ok: true, connectionState: 'needs-auth' }),
      ),
    )
    const status: RuntimeStatus = { id: 'hermes', connectionState: 'ready', authKind: 'api-key' }
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['hermes']}
        status={status}
        variant="panel"
        onChanged={onChanged}
      />,
    )
    expect(screen.getByText('Connected')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('runtime-hermes-disconnect'))
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('Disconnect cancelled at the confirm → no POST, no onChanged', async () => {
    const onChanged = vi.fn()
    const posted = vi.fn()
    vi.mocked(confirm).mockResolvedValue(false)
    server.use(
      http.post('/api/runtimes/hermes/disconnect', () => {
        posted()
        return HttpResponse.json({ ok: true })
      }),
    )
    const status: RuntimeStatus = { id: 'hermes', connectionState: 'ready', authKind: 'api-key' }
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['hermes']}
        status={status}
        variant="panel"
        onChanged={onChanged}
      />,
    )
    await userEvent.click(screen.getByTestId('runtime-hermes-disconnect'))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(posted).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('failed Disconnect surfaces the error and does NOT call onChanged', async () => {
    const onChanged = vi.fn()
    vi.mocked(confirm).mockResolvedValue(true)
    server.use(
      http.post('/api/runtimes/hermes/disconnect', () =>
        HttpResponse.json({ ok: false, error: 'vault is locked' }, { status: 500 }),
      ),
    )
    const status: RuntimeStatus = { id: 'hermes', connectionState: 'ready', authKind: 'api-key' }
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['hermes']}
        status={status}
        variant="panel"
        onChanged={onChanged}
      />,
    )
    await userEvent.click(screen.getByTestId('runtime-hermes-disconnect'))
    expect(await screen.findByText(/vault is locked/i)).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('onboarding variant hides Disconnect on a ready card', () => {
    const status: RuntimeStatus = { id: 'hermes', connectionState: 'ready', authKind: 'api-key' }
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['hermes']}
        status={status}
        variant="onboarding"
      />,
    )
    expect(screen.queryByTestId('runtime-hermes-disconnect')).not.toBeInTheDocument()
  })

  it('wizard-primary: a pick surface with the Recommended pill — fires onPick, no connect machinery', async () => {
    const onPick = vi.fn()
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['clawboo-native']}
        variant="wizard-primary"
        onPick={onPick}
      />,
    )
    const card = screen.getByTestId('runtime-pick-clawboo-native')
    expect(card).toHaveAttribute('data-variant', 'wizard-primary')
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    // No install / key inputs in pick mode — selection only.
    expect(screen.queryByTestId('runtime-clawboo-native-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-clawboo-native-install')).not.toBeInTheDocument()
    await userEvent.click(card)
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('wizard-secondary: a muted pick surface — no Recommended pill, fires onPick', async () => {
    const onPick = vi.fn()
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['claude-code']}
        variant="wizard-secondary"
        onPick={onPick}
      />,
    )
    const card = screen.getByTestId('runtime-pick-claude-code')
    expect(card).toHaveAttribute('data-variant', 'wizard-secondary')
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument()
    await userEvent.click(card)
    expect(onPick).toHaveBeenCalledTimes(1)
  })
})
