// OpenClawInlineSetup — the compact IN-PLACE OpenClaw setup. Verifies the two
// load-bearing behaviors: (1) it reuses an already-connected provider (a key or a
// local Ollama, via auto-configure) and NEVER shows a key prompt; (2) it falls
// back to a compact key prompt only when nothing is connected. Also covers the
// pairing card: a failed reconnect after approval must never strand it on
// "Reconnecting…". And a local Ollama without OpenClaw's default model stops on
// the pull command before the Gateway starts. The gateway connect +
// enterGatewayMode are mocked (no real WebSocket in jsdom).

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GatewayResponseError, type GatewayClient } from '@clawboo/gateway-client'

import { server } from '@/__vitest__/mswServer'
import { connectGatewayFromSettings } from '@/lib/gatewayConnect'
import { OpenClawInlineSetup } from '../OpenClawInlineSetup'

vi.mock('@/lib/gatewayConnect', () => ({
  connectGatewayFromSettings: vi.fn(async () => ({
    client: {} as GatewayClient,
    gatewayUrl: 'ws://localhost:18789',
  })),
}))
vi.mock('@/features/connection/GatewayBootstrap', () => ({
  enterGatewayMode: vi.fn(async () => {}),
}))

afterEach(() => cleanup())

const sseComplete = () =>
  new HttpResponse('data: {"type":"complete","success":true}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })

// A configured, installed OpenClaw whose Gateway starts; the pairing card's
// approve call succeeds.
function useReadyGateway() {
  server.use(
    http.post('/api/system/auto-configure-openclaw', () =>
      HttpResponse.json({ ok: true, gatewayUrl: 'ws://localhost:18789', provider: 'anthropic' }),
    ),
    http.get('/api/system/status', () => HttpResponse.json({ openclaw: { installed: true } })),
    http.post('/api/system/gateway', sseComplete),
    http.post('/api/system/approve-device', () => HttpResponse.json({ ok: true })),
  )
}

const notPaired = () =>
  new GatewayResponseError({
    code: 'NOT_PAIRED',
    message: 'pairing required: device is not approved yet',
  })

describe('OpenClawInlineSetup', () => {
  // A key, and a local Ollama with its default model pulled, answer the same way.
  it.each([
    { provider: 'anthropic' },
    { provider: 'ollama', model: 'ollama/llama3.2', modelPulled: true },
  ])(
    'reuses a connected $provider: auto-configure → start → connect (NO key prompt)',
    async (answer) => {
      server.use(
        http.post('/api/system/auto-configure-openclaw', () =>
          HttpResponse.json({ ok: true, gatewayUrl: 'ws://localhost:18789', ...answer }),
        ),
        http.get('/api/system/status', () => HttpResponse.json({ openclaw: { installed: true } })),
        http.post(
          '/api/system/gateway',
          () =>
            new HttpResponse('data: {"type":"complete","success":true}\n\n', {
              headers: { 'Content-Type': 'text/event-stream' },
            }),
        ),
      )
      const onFinish = vi.fn()
      const onConnected = vi.fn()
      render(
        <OpenClawInlineSetup onFinish={onFinish} onCancel={vi.fn()} onConnected={onConnected} />,
      )
      // Connects without ever asking for a key.
      await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
      expect(screen.queryByTestId('openclaw-inline-key')).not.toBeInTheDocument()
      await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1), { timeout: 2000 })
    },
  )

  // OpenClaw is configured on a local Ollama that lacks the default model.
  function serveOllamaWithoutModel(pulledAfter: number): {
    autoCalls: () => number
    gatewayCalls: () => number
  } {
    let auto = 0
    let gateway = 0
    server.use(
      http.post('/api/system/auto-configure-openclaw', () => {
        auto += 1
        return HttpResponse.json({
          ok: true,
          gatewayUrl: 'ws://localhost:18789',
          provider: 'ollama',
          model: 'ollama/llama3.2',
          ...(auto > pulledAfter
            ? { modelPulled: true }
            : { modelPulled: false, pullCommand: 'ollama pull llama3.2' }),
        })
      }),
      http.get('/api/system/status', () => HttpResponse.json({ openclaw: { installed: true } })),
      http.post('/api/system/gateway', () => {
        gateway += 1
        return new HttpResponse('data: {"type":"complete","success":true}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }),
    )
    return { autoCalls: () => auto, gatewayCalls: () => gateway }
  }

  it('an Ollama without the default model stops on its pull command, before the Gateway', async () => {
    const calls = serveOllamaWithoutModel(1)
    const onConnected = vi.fn()
    render(<OpenClawInlineSetup onFinish={vi.fn()} onCancel={vi.fn()} onConnected={onConnected} />)

    const panel = await screen.findByTestId('openclaw-inline-needs-model')
    expect(panel).toHaveTextContent(/couldn.t find ollama\/llama3\.2/i)
    expect(screen.getByTestId('openclaw-inline-pull-command')).toHaveTextContent(
      /^ollama pull llama3\.2$/,
    )
    // No plain success, and no Gateway started for a model that can't answer.
    expect(calls.gatewayCalls()).toBe(0)
    expect(onConnected).not.toHaveBeenCalled()

    // Pulled now: Check again re-runs the setup and connects.
    await userEvent.click(screen.getByTestId('openclaw-inline-model-recheck'))
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
    expect(calls.autoCalls()).toBe(2)
    expect(calls.gatewayCalls()).toBe(1)
  })

  it('Continue anyway connects without the model', async () => {
    const calls = serveOllamaWithoutModel(Infinity)
    const onConnected = vi.fn()
    render(<OpenClawInlineSetup onFinish={vi.fn()} onCancel={vi.fn()} onConnected={onConnected} />)
    await userEvent.click(await screen.findByTestId('openclaw-inline-continue-anyway'))
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
    expect(calls.autoCalls()).toBe(1)
    expect(calls.gatewayCalls()).toBe(1)
  })

  it('falls back to a compact key prompt when no provider is connected', async () => {
    server.use(
      http.post('/api/system/auto-configure-openclaw', () =>
        HttpResponse.json({ ok: false, needsKey: true }),
      ),
    )
    render(<OpenClawInlineSetup onFinish={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByTestId('openclaw-inline-key')).toBeInTheDocument()
  })

  it('needsCodexAuth: ensures the INSTALL first, then shows the quiet subscription panel + Re-check', async () => {
    let autoCalls = 0
    let installCalls = 0
    server.use(
      http.post('/api/system/auto-configure-openclaw', () => {
        autoCalls += 1
        // First pass: the subscription exists (codex login) but OpenClaw has no
        // profile. After the user runs the login + clicks Re-check: configured.
        return autoCalls === 1
          ? HttpResponse.json({
              ok: false,
              needsCodexAuth: true,
              loginCommand: 'openclaw models auth login --provider openai-codex',
            })
          : HttpResponse.json({
              ok: true,
              gatewayUrl: 'ws://localhost:18789',
              provider: 'openai-codex',
            })
      }),
      // NOT installed → the install SSE must run BEFORE the login panel (the
      // sign-in is useless without the binary).
      http.get('/api/system/status', () => HttpResponse.json({ openclaw: { installed: false } })),
      http.post('/api/system/install-openclaw', () => {
        installCalls += 1
        return new HttpResponse('data: {"type":"complete","success":true}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }),
      http.post(
        '/api/system/gateway',
        () =>
          new HttpResponse('data: {"type":"complete","success":true}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
    )
    const onConnected = vi.fn()
    render(<OpenClawInlineSetup onFinish={vi.fn()} onCancel={vi.fn()} onConnected={onConnected} />)

    // The subscription panel: detection-framed ("Codex is connected"), with the
    // one-click sign-in — the manual command lives in the flow's failure states,
    // never as standing chrome (and it's the NON-destructive login, not onboard).
    const panel = await screen.findByTestId('openclaw-inline-codex-auth')
    // The binary was ensured FIRST — the install SSE ran before the panel.
    expect(installCalls).toBe(1)
    expect(panel).toHaveTextContent(/Codex is connected/i)
    expect(screen.getByTestId('chatgpt-signin-openclaw-start')).toBeInTheDocument()
    // No key prompt — the subscription path doesn't ask for one (the escape
    // hatch to the key flow is explicit).
    expect(screen.queryByTestId('openclaw-inline-key')).not.toBeInTheDocument()
    expect(screen.getByTestId('openclaw-inline-use-key')).toBeInTheDocument()

    // Re-check → auto-configure now succeeds (rung 2) → connects keylessly.
    await userEvent.click(screen.getByTestId('openclaw-inline-codex-recheck'))
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
  })

  // The card waits 700 ms after a successful approve before it hands back, so
  // the post-approval assertions get a longer budget.
  it('a reconnect that fails after approval lands in the error state with Retry', async () => {
    useReadyGateway()
    vi.mocked(connectGatewayFromSettings)
      .mockRejectedValueOnce(notPaired())
      .mockRejectedValueOnce(new Error('Gateway closed the connection'))
    const onConnected = vi.fn()
    render(<OpenClawInlineSetup onFinish={vi.fn()} onCancel={vi.fn()} onConnected={onConnected} />)

    await userEvent.click(await screen.findByTestId('device-pairing-approve-button'))

    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      'Gateway closed the connection',
    )
    expect(screen.queryByTestId('device-pairing-approval')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('a second NOT_PAIRED after approval offers Retry, which brings back an approvable card', async () => {
    useReadyGateway()
    vi.mocked(connectGatewayFromSettings)
      .mockRejectedValueOnce(notPaired())
      .mockRejectedValueOnce(notPaired())
      .mockRejectedValueOnce(notPaired())
    const onConnected = vi.fn()
    render(<OpenClawInlineSetup onFinish={vi.fn()} onCancel={vi.fn()} onConnected={onConnected} />)

    await userEvent.click(await screen.findByTestId('device-pairing-approve-button'))
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      /still needs this device approved/,
    )
    expect(screen.queryByTestId('device-pairing-approval')).not.toBeInTheDocument()

    // Retry re-runs the setup; the Gateway still says NOT_PAIRED, so a FRESH
    // card appears with its approve button live again.
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const approve = await screen.findByTestId('device-pairing-approve-button')
    expect(approve).toBeEnabled()
    expect(approve).toHaveTextContent('Approve this device')

    // Approving this time connects (the mock falls back to a live client).
    await userEvent.click(approve)
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 3000 })
  })
})
