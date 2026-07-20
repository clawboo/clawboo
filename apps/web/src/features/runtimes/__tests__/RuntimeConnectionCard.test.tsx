// RuntimeConnectionCard — the shared connection state machine. RTL pattern:
// msw (onUnhandledRequest:'error') + jest-dom + userEvent. The card starts at
// the server's connectionState; there is no flag-flip "available → Add" step.

import { useState } from 'react'
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

  it('after install completes, the "installed" ack appears above the connect step', async () => {
    server.use(
      http.post(
        '/api/runtimes/hermes/install',
        () =>
          new HttpResponse('data: {"type":"complete","success":true}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    )
    // A stateful host: onChanged flips the refetched status from not-installed →
    // needs-auth, exactly as the live RuntimeConnectList refetch does.
    function Host() {
      const [state, setState] = useState<RuntimeStatus>({
        id: 'hermes',
        connectionState: 'not-installed',
        authKind: 'api-key',
        envVar: 'OPENROUTER_API_KEY',
      })
      return (
        <RuntimeConnectionCard
          entry={RUNTIME_CATALOG['hermes']}
          status={state}
          variant="panel"
          onChanged={() => setState((s) => ({ ...s, connectionState: 'needs-auth' }))}
        />
      )
    }
    render(<Host />)
    expect(screen.queryByTestId('runtime-hermes-installed-ack')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('runtime-hermes-install'))
    // The success beat lands, and the key input (the connect step) is right there.
    const ack = await screen.findByTestId('runtime-hermes-installed-ack')
    expect(ack).toHaveTextContent(/Hermes installed/i)
    expect(screen.getByTestId('runtime-hermes-key')).toBeInTheDocument()
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

  it('needs-auth (hermes): the ChatGPT-subscription option appears ONLY once Codex is detected', async () => {
    const status: RuntimeStatus = {
      id: 'hermes',
      connectionState: 'needs-auth',
      authKind: 'api-key',
      envVar: 'OPENROUTER_API_KEY',
    }
    // Codex NOT connected → no subscription affordance at all: the subscription
    // gets set up on the Providers surfaces, never demanded from a runtime row.
    const first = render(
      <RuntimeConnectionCard entry={RUNTIME_CATALOG['hermes']} status={status} variant="panel" />,
    )
    expect(screen.queryByTestId('runtime-hermes-alt-login')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-hermes-key')).toBeInTheDocument()
    first.unmount()

    // Codex connected → a QUIET optional block under the key input.
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['hermes']}
        status={status}
        variant="panel"
        codexReady
      />,
    )
    const alt = screen.getByTestId('runtime-hermes-alt-login')
    expect(alt).toHaveTextContent(/Codex is connected/i)
    expect(alt).toHaveTextContent(/ChatGPT subscription/i)
    // The one-click sign-in (never a filled-primary demand) is inside the block.
    expect(screen.getByTestId('chatgpt-signin-hermes-start')).toBeInTheDocument()
    // The key path stays primary — both affordances coexist.
    expect(screen.getByTestId('runtime-hermes-key')).toBeInTheDocument()
  })

  it('needs-login (codex): the one-click sign-in + Re-check', async () => {
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
    // The one-click sign-in IS codex's connect action; the manual command
    // surfaces inside the flow's failure states, not as standing chrome.
    expect(screen.getByTestId('chatgpt-signin-codex-start')).toBeInTheDocument()
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

  it('onDisplayState reports the live state (the tab-dot contract): installing → terminal', async () => {
    const onDisplayState = vi.fn()
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
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['claude-code']}
        status={{ id: 'claude-code', connectionState: 'not-installed' } as RuntimeStatus}
        variant="onboarding"
        onDisplayState={onDisplayState}
      />,
    )
    expect(onDisplayState).toHaveBeenLastCalledWith('not-installed')
    await userEvent.click(screen.getByTestId('runtime-claude-code-install'))
    await waitFor(() => expect(onDisplayState).toHaveBeenCalledWith('installing'))
    // After the SSE completes, the state settles back to the server-derived one.
    await waitFor(() => expect(onDisplayState).toHaveBeenLastCalledWith('not-installed'))
  })

  // ── Native multi-provider connect (the reconnect-only-showed-Anthropic fix) ──

  const NATIVE_STATUS: RuntimeStatus = {
    id: 'clawboo-native',
    connectionState: 'needs-auth',
    authKind: 'api-key',
    envVar: 'ANTHROPIC_API_KEY',
  }

  it('native needs-auth renders the PROVIDER MANAGER (no single hardcoded-Anthropic input, no global Connect)', async () => {
    server.use(
      http.get('/api/providers', () =>
        HttpResponse.json({
          providers: [{ id: 'openrouter', connected: true, poweredRuntimes: [] }],
        }),
      ),
    )
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['clawboo-native']}
        status={NATIVE_STATUS}
        variant="panel"
      />,
    )
    // The provider manager owns the body…
    expect(await screen.findByTestId('native-providers-body')).toBeInTheDocument()
    await screen.findByTestId('native-provider-row-openrouter')
    // …and the old single-envVar affordances are gone: no card-level key input,
    // no global Connect (the per-row buttons own the action).
    expect(screen.queryByTestId('runtime-clawboo-native-key')).toBeNull()
    expect(screen.queryByTestId('runtime-clawboo-native-connect')).toBeNull()
  })

  it('a NON-native api-key runtime keeps the single-envVar body (no provider manager, no provider in the POST)', async () => {
    const posts: unknown[] = []
    server.use(
      http.post('/api/runtimes/hermes/connect', async ({ request }) => {
        posts.push(await request.json())
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
    )
    render(
      <RuntimeConnectionCard
        entry={RUNTIME_CATALOG['hermes']}
        status={{
          id: 'hermes',
          connectionState: 'needs-auth',
          authKind: 'api-key',
          envVar: 'OPENROUTER_API_KEY',
        }}
        variant="panel"
      />,
    )
    expect(screen.queryByTestId('native-providers-body')).toBeNull()
    await userEvent.type(screen.getByTestId('runtime-hermes-key'), 'sk-or-h')
    await userEvent.click(screen.getByTestId('runtime-hermes-connect'))
    await waitFor(() => expect(posts).toContainEqual({ apiKey: 'sk-or-h' }))
  })
})
