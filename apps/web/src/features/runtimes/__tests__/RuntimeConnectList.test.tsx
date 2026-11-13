// RuntimeConnectList — the redesigned connected CARD: a small "Connected" status
// top-right + a Manage footer button that expands the inline management body
// (the ChatGPT-subscription option, Disconnect, Details). Prop-driven (no fetch
// on render); RTL + jest-dom + userEvent.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeStatus } from '@clawboo/control-client'

import { server } from '../../../__vitest__/mswServer'
import { useSettingsModalStore } from '@/stores/settingsModal'
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

describe('RuntimeConnectList: native on local Ollama', () => {
  // Readied by Ollama alone: ready, with no key behind it.
  const NATIVE_OLLAMA: RuntimeStatus = {
    id: 'clawboo-native',
    connectionState: 'ready',
    hasCredential: false,
    ollamaConnected: true,
  }

  it('the panel row lists Ollama as a connected provider in Manage', async () => {
    render(
      <RuntimeConnectList
        runtimeIds={['clawboo-native']}
        statuses={[NATIVE_OLLAMA]}
        loaded
        variant="panel"
        onChanged={vi.fn()}
        onDiagnostics={vi.fn()}
        openclaw={OPENCLAW_OFF}
      />,
    )
    expect(await screen.findByTestId('native-provider-row-ollama')).toHaveTextContent('Connected')
  })

  it('the onboarding foundation row lists the Ollama picked on the connect step', async () => {
    render(
      <RuntimeConnectList
        runtimeIds={[]}
        statuses={[NATIVE_OLLAMA]}
        loaded
        variant="onboarding"
        onChanged={vi.fn()}
        openclaw={OPENCLAW_OFF}
      />,
    )
    expect(await screen.findByTestId('native-provider-row-ollama')).toHaveTextContent('Connected')
  })
})

describe('RuntimeConnectList: a Codex CLI too old for the plan', () => {
  function renderCodex(status: RuntimeStatus, onChanged = vi.fn()) {
    return render(
      <RuntimeConnectList
        runtimeIds={['codex']}
        statuses={[status]}
        loaded
        variant="panel"
        onChanged={onChanged}
        openclaw={OPENCLAW_OFF}
      />,
    )
  }

  it('reads "Update needed" (not Connected), and its toggle reveals the notice', async () => {
    renderCodex({
      id: 'codex',
      connectionState: 'ready',
      updateRequired: true,
      cliVersion: '0.136.0',
    })
    expect(screen.getByText('Update needed')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    const toggle = screen.getByTestId('runtime-list-row-codex-toggle')
    expect(toggle).toHaveTextContent(/Update/i)
    await userEvent.click(toggle)
    expect(screen.getByTestId('runtime-codex-update-required')).toHaveTextContent(
      /Codex CLI \(0\.136\.0\) is too old/,
    )
    // Sign out + Re-check stay available beside it.
    expect(screen.getByTestId('runtime-codex-disconnect')).toBeInTheDocument()
  })

  it('Update Codex runs the install stream, then re-reads the status', async () => {
    let installs = 0
    server.use(
      http.post('/api/runtimes/codex/install', () => {
        installs += 1
        return new HttpResponse('data: {"type":"complete","success":true}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }),
    )
    const onChanged = vi.fn()
    renderCodex({ id: 'codex', connectionState: 'ready', updateRequired: true }, onChanged)
    await userEvent.click(screen.getByTestId('runtime-list-row-codex-toggle'))
    await userEvent.click(screen.getByTestId('runtime-codex-update'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(installs).toBe(1)
  })

  it('Update Codex waits for the new CLI model read before re-reading the status', async () => {
    // The install drops the server's model probe and the runtime list does not wait
    // for the new one, so a status read first would miss a CLI that still needs it.
    const order: string[] = []
    let releaseModels: () => void = () => {}
    server.use(
      http.post(
        '/api/runtimes/codex/install',
        () =>
          new HttpResponse('data: {"type":"complete","success":true}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
      http.get('/api/runtimes/codex/models', async () => {
        order.push('models requested')
        await new Promise<void>((r) => {
          releaseModels = r
        })
        order.push('models answered')
        return HttpResponse.json({ models: [], defaultModel: null, updateRequired: true })
      }),
    )
    const onChanged = vi.fn(() => {
      order.push('status re-read')
    })
    renderCodex({ id: 'codex', connectionState: 'ready', updateRequired: true }, onChanged)
    await userEvent.click(screen.getByTestId('runtime-list-row-codex-toggle'))
    await userEvent.click(screen.getByTestId('runtime-codex-update'))
    await waitFor(() => expect(order).toContain('models requested'))
    expect(onChanged).not.toHaveBeenCalled()
    releaseModels()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(order).toEqual(['models requested', 'models answered', 'status re-read'])
  })

  it('a current Codex reads Connected with Manage and no notice', () => {
    renderCodex({ id: 'codex', connectionState: 'ready', updateRequired: false })
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-codex-toggle')).toHaveTextContent(/Manage/i)
    expect(screen.queryByTestId('runtime-codex-update-required')).not.toBeInTheDocument()
  })
})

describe('RuntimeConnectList: a Hermes that is not Clawboo’s current install', () => {
  function renderHermes(status: RuntimeStatus, onChanged = vi.fn()) {
    return render(
      <RuntimeConnectList
        runtimeIds={['hermes']}
        statuses={[status]}
        loaded
        variant="panel"
        onChanged={onChanged}
        openclaw={OPENCLAW_OFF}
      />,
    )
  }

  it('reads "Update needed", and its toggle reveals the notice beside the providers', async () => {
    renderHermes({ id: 'hermes', connectionState: 'ready', codexAuth: false, updateRequired: true })
    expect(screen.getByText('Update needed')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    const toggle = screen.getByTestId('runtime-list-row-hermes-toggle')
    expect(toggle).toHaveTextContent(/Update/i)
    await userEvent.click(toggle)
    expect(screen.getByTestId('runtime-hermes-update-required')).toHaveTextContent(
      /installs its own copy of Hermes/,
    )
    // Its keys and sign-in stay managed here too.
    expect(await screen.findByTestId('runtime-hermes-subscription-needs-codex')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-hermes-disconnect')).toBeInTheDocument()
  })

  it('reads "Update needed" for a Hermes found only on PATH, not "Not installed"', async () => {
    renderHermes({ id: 'hermes', connectionState: 'not-installed', updateRequired: true })
    expect(screen.getByText('Update needed')).toBeInTheDocument()
    expect(screen.queryByText('Not installed')).not.toBeInTheDocument()
    const toggle = screen.getByTestId('runtime-list-row-hermes-toggle')
    expect(toggle).toHaveTextContent(/Update/i)
    await userEvent.click(toggle)
    expect(screen.getByTestId('runtime-hermes-update-required')).toHaveTextContent(
      /memory and skills carry over/,
    )
    expect(screen.getByTestId('runtime-hermes-update')).toBeEnabled()
  })

  it('Update Hermes runs the install stream, then re-reads the status', async () => {
    let installs = 0
    server.use(
      http.post('/api/runtimes/hermes/install', () => {
        installs += 1
        return new HttpResponse('data: {"type":"complete","success":true}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }),
    )
    // The status re-read is held open, so the button must stay busy until it lands.
    let releaseRefetch: () => void = () => {}
    const onChanged = vi.fn(
      () =>
        new Promise<void>((r) => {
          releaseRefetch = r
        }),
    )
    renderHermes({ id: 'hermes', connectionState: 'ready', updateRequired: true }, onChanged)
    await userEvent.click(screen.getByTestId('runtime-list-row-hermes-toggle'))
    await userEvent.click(screen.getByTestId('runtime-hermes-update'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(installs).toBe(1)
    expect(screen.getByTestId('runtime-hermes-update')).toHaveTextContent('Updating Hermes…')
    releaseRefetch()
    await waitFor(() =>
      expect(screen.getByTestId('runtime-hermes-update')).toHaveTextContent('Update Hermes'),
    )
  })

  it('a failed update says why and lets you try again', async () => {
    server.use(
      http.post(
        '/api/runtimes/hermes/install',
        () =>
          new HttpResponse(
            'data: {"type":"error","code":"EXIT_1","message":"Installation failed with exit code 1"}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    )
    const onChanged = vi.fn()
    renderHermes({ id: 'hermes', connectionState: 'ready', updateRequired: true }, onChanged)
    await userEvent.click(screen.getByTestId('runtime-list-row-hermes-toggle'))
    await userEvent.click(screen.getByTestId('runtime-hermes-update'))
    expect(await screen.findByText('Installation failed with exit code 1')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-hermes-update')).toBeEnabled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('a current Hermes reads Connected, and Manage shows its gateway', async () => {
    server.use(
      http.get('/api/runtimes/hermes/gateway', () =>
        HttpResponse.json({
          state: 'running',
          port: 8642,
          pid: 1,
          startedAt: Date.now() - 120_000,
          restarts: 0,
          lastError: null,
          version: '0.23.1',
        }),
      ),
    )
    renderHermes({ id: 'hermes', connectionState: 'ready' })
    expect(screen.getByText('Connected')).toBeInTheDocument()
    const toggle = screen.getByTestId('runtime-list-row-hermes-toggle')
    expect(toggle).toHaveTextContent(/Manage/i)
    expect(screen.queryByTestId('runtime-hermes-update-required')).not.toBeInTheDocument()
    await userEvent.click(toggle)
    const section = await screen.findByTestId('hermes-gateway-section')
    await waitFor(() => expect(section).toHaveTextContent('Running'))
    expect(section).toHaveTextContent('127.0.0.1:8642')
    expect(section).toHaveTextContent('v0.23.1')
    expect(screen.getByTestId('hermes-gateway-restart')).toBeInTheDocument()
  })

  it('a gateway that could not start says why and offers Start', async () => {
    let started = 0
    server.use(
      http.get('/api/runtimes/hermes/gateway', () =>
        HttpResponse.json({
          state: 'failed',
          port: null,
          pid: null,
          startedAt: null,
          restarts: 3,
          lastError: 'Hermes did not answer on its port: [ERROR] api_server_port_in_use',
          version: null,
        }),
      ),
      http.post('/api/runtimes/hermes/gateway', () => {
        started += 1
        return HttpResponse.json({ ok: true, status: { state: 'running', port: 8643 } })
      }),
    )
    renderHermes({ id: 'hermes', connectionState: 'ready' })
    await userEvent.click(screen.getByTestId('runtime-list-row-hermes-toggle'))
    expect(await screen.findByText(/api_server_port_in_use/)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('hermes-gateway-start'))
    await waitFor(() => expect(started).toBe(1))
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

describe('RuntimeConnectList: opening at a runtime to fix its sign-in', () => {
  const HERMES_READY: RuntimeStatus = {
    id: 'hermes',
    connectionState: 'ready',
    hasCredential: true,
  }

  beforeEach(() => useSettingsModalStore.setState({ focusRuntime: null }))

  it("expands the asked-for runtime's row, scrolls it into view, and clears the ask", async () => {
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    try {
      useSettingsModalStore.setState({ focusRuntime: 'hermes' })
      renderList([HERMES_READY])
      await waitFor(() =>
        expect(screen.getByTestId('runtime-list-row-hermes-toggle')).toHaveAttribute(
          'aria-expanded',
          'true',
        ),
      )
      expect(scrolled).toContain(screen.getByTestId('runtime-list-row-hermes'))
      expect(useSettingsModalStore.getState().focusRuntime).toBeNull()
      // OpenClaw was not asked for and stays closed.
      expect(screen.getByTestId('runtime-list-row-openclaw-toggle')).toHaveAttribute(
        'aria-expanded',
        'false',
      )
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('opens the OpenClaw row too', async () => {
    useSettingsModalStore.setState({ focusRuntime: 'openclaw' })
    renderList([])
    await waitFor(() =>
      expect(screen.getByTestId('runtime-list-row-openclaw-toggle')).toHaveAttribute(
        'aria-expanded',
        'true',
      ),
    )
  })
})
