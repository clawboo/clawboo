// ConfigureNativeStep — paste a provider key, (optionally) test it, then continue
// to team selection. RTL pattern (msw onUnhandledRequest:'error' + jest-dom +
// userEvent). The load-bearing assertion: the pasted key is written via the
// connect route ONLY and never propagates to any other request or a response.
// This step no longer creates a team (real team selection is the next step); it
// records the chosen leader model so the universal Boo Zero runs on it.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ConfigureNativeStep } from '../steps/ConfigureNativeStep'

afterEach(() => cleanup())

const SECRET = 'sk-ant-SECRET-DO-NOT-LEAK'

describe('ConfigureNativeStep', () => {
  it('reveal toggle switches the key field between password and text', async () => {
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    const input = screen.getByTestId('native-api-key')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByLabelText('Show API key'))
    expect(input).toHaveAttribute('type', 'text')
  })

  it('selecting a provider marks its card checked', async () => {
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    expect(screen.getByTestId('native-provider-anthropic')).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByTestId('native-provider-openai'))
    expect(screen.getByTestId('native-provider-openai')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('native-provider-anthropic')).toHaveAttribute('aria-checked', 'false')
  })

  it('shows a "Get a key" link that re-points per selected provider', async () => {
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    expect(screen.getByTestId('native-get-key').getAttribute('href')).toContain(
      'console.anthropic.com',
    )
    await userEvent.click(screen.getByTestId('native-provider-openrouter'))
    expect(screen.getByTestId('native-get-key').getAttribute('href')).toContain('openrouter.ai')
  })

  it('the "More providers" section reveals extra providers; selecting one switches the provider', async () => {
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    // Hidden until expanded.
    expect(screen.queryByTestId('native-provider-groq')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('native-more-providers-toggle'))
    // The extra providers are now shown.
    const groq = await screen.findByTestId('native-provider-groq')
    expect(screen.getByTestId('native-provider-google')).toBeInTheDocument()
    // Selecting one activates it + deselects the primary Anthropic card…
    await userEvent.click(groq)
    expect(groq).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('native-provider-anthropic')).toHaveAttribute('aria-checked', 'false')
    // …and re-points the "Get a key" link to that provider.
    expect(screen.getByTestId('native-get-key').getAttribute('href')).toContain('groq.com')
  })

  it('Test connection reports success when the key works', async () => {
    server.use(
      http.post('/api/runtimes/clawboo-native/healthcheck', () => HttpResponse.json({ ok: true })),
    )
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-test-connection'))
    expect(await screen.findByText('Key works')).toBeInTheDocument()
  })

  it('submit connects the key → onConnected(provider, model); the key never reaches the model-persist call or a response', async () => {
    const onConnected = vi.fn()
    let connectBody: Record<string, unknown> | null = null
    let modelBody: Record<string, unknown> | null = null
    const responses: string[] = []

    server.use(
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        connectBody = (await request.json()) as Record<string, unknown>
        const body = { ok: true, connectionState: 'ready' }
        responses.push(JSON.stringify(body))
        return HttpResponse.json(body)
      }),
      http.post('/api/onboarding/native-leader-model', async ({ request }) => {
        modelBody = (await request.json()) as Record<string, unknown>
        const body = { ok: true }
        responses.push(JSON.stringify(body))
        return HttpResponse.json(body)
      }),
    )

    render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-continue'))

    // Advances with the connected provider + the chosen leader model (default =
    // the provider's strongest).
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5'))

    // The key rides the connect request (its single legitimate destination)…
    expect(connectBody).toEqual({ apiKey: SECRET, provider: 'anthropic' })
    // …but NEVER the model-persist request,…
    await waitFor(() => expect(modelBody).not.toBeNull())
    expect(JSON.stringify(modelBody)).not.toContain(SECRET)
    expect(modelBody).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })
    // …and NEVER any response body.
    for (const r of responses) expect(r).not.toContain(SECRET)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    await screen.findByTestId('configure-native-step')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })

  it('Ollama card hides the key field and connects keyless', async () => {
    const onConnected = vi.fn()
    let connectBody: Record<string, unknown> | null = null
    server.use(
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        connectBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, connectionState: 'needs-auth' })
      }),
      http.post('/api/onboarding/native-leader-model', () => HttpResponse.json({ ok: true })),
    )
    render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-provider-ollama'))
    expect(screen.queryByTestId('native-api-key')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('native-continue'))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('ollama', 'llama3.2'))
    expect(connectBody).toEqual({ apiKey: '', provider: 'ollama' })
  })

  // Sign in with ChatGPT — the Codex subscription path on the OpenAI card. Codex
  // login is TERMINAL-only: the panel probes GET /api/runtimes for the codex
  // connectionState and never automates the OAuth exchange. Continue must gate on
  // a verified `ready` probe, and the codex path must NEVER touch the native
  // connect/model routes (there is no key to store).
  describe('Sign in with ChatGPT (OpenAI card)', () => {
    const codexRuntimes = (over: Record<string, unknown>) =>
      http.get('/api/runtimes', () =>
        HttpResponse.json({ runtimes: [{ id: 'codex', installed: true, ...over }] }),
      )

    it('is the DEFAULT method on the OpenAI card, carries the Recommended chip, and hides the key + model fields; no method cards on other providers', async () => {
      server.use(codexRuntimes({ connectionState: 'needs-login' }))
      render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
      // Anthropic (default provider) shows no auth-method selector.
      expect(screen.queryByTestId('native-auth-chatgpt')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('native-provider-openai'))
      // ChatGPT is pre-selected + Recommended (the economical/subscription framing).
      expect(screen.getByTestId('native-auth-chatgpt')).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByTestId('native-auth-api-key')).toHaveAttribute('aria-checked', 'false')
      expect(screen.getByText('Recommended')).toBeInTheDocument()
      expect(screen.getByText(/no API key needed/i)).toBeInTheDocument()
      // The key field + model picker are the api-key method's UI — hidden here.
      expect(screen.queryByTestId('native-api-key')).not.toBeInTheDocument()
      expect(screen.queryByText('Model')).not.toBeInTheDocument()
      // Not signed in yet → Continue stays disabled.
      await screen.findByTestId('native-chatgpt-panel')
      expect(screen.getByText('codex login')).toBeInTheDocument()
      expect(screen.getByTestId('native-continue')).toBeDisabled()
    })

    it('not-installed shows the install command alongside the login command', async () => {
      server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [] })))
      render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
      await userEvent.click(screen.getByTestId('native-provider-openai'))
      expect(await screen.findByText('npm install -g @openai/codex')).toBeInTheDocument()
      expect(screen.getByText('codex login')).toBeInTheDocument()
      expect(screen.getByTestId('native-continue')).toBeDisabled()
    })

    it('Re-check re-probes: needs-login → ready enables Continue', async () => {
      let calls = 0
      server.use(
        http.get('/api/runtimes', () => {
          calls += 1
          return HttpResponse.json({
            runtimes: [
              {
                id: 'codex',
                installed: true,
                connectionState: calls > 1 ? 'ready' : 'needs-login',
              },
            ],
          })
        }),
      )
      render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
      await userEvent.click(screen.getByTestId('native-provider-openai'))
      await userEvent.click(await screen.findByTestId('native-chatgpt-recheck'))
      await screen.findByTestId('native-chatgpt-ready')
      expect(screen.getByTestId('native-continue')).toBeEnabled()
    })

    it('Continue on a ready sign-in fires onConnected("codex", "") WITHOUT calling the native connect or model routes', async () => {
      const onConnected = vi.fn()
      let connectCalled = false
      let modelCalled = false
      server.use(
        codexRuntimes({ connectionState: 'ready' }),
        http.post('/api/runtimes/clawboo-native/connect', () => {
          connectCalled = true
          return HttpResponse.json({ ok: true })
        }),
        http.post('/api/onboarding/native-leader-model', () => {
          modelCalled = true
          return HttpResponse.json({ ok: true })
        }),
      )
      render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
      await userEvent.click(screen.getByTestId('native-provider-openai'))
      await screen.findByTestId('native-chatgpt-ready')
      await userEvent.click(screen.getByTestId('native-continue'))
      await waitFor(() => expect(onConnected).toHaveBeenCalledWith('codex', ''))
      expect(connectCalled).toBe(false)
      expect(modelCalled).toBe(false)
    })

    it('switching to the API key method restores the key flow (connects with provider "openai")', async () => {
      const onConnected = vi.fn()
      let connectBody: Record<string, unknown> | null = null
      server.use(
        codexRuntimes({ connectionState: 'needs-login' }),
        http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
          connectBody = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({ ok: true, connectionState: 'ready' })
        }),
        http.post('/api/onboarding/native-leader-model', () => HttpResponse.json({ ok: true })),
      )
      render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
      await userEvent.click(screen.getByTestId('native-provider-openai'))
      await userEvent.click(screen.getByTestId('native-auth-api-key'))
      expect(screen.queryByTestId('native-chatgpt-panel')).not.toBeInTheDocument()
      await userEvent.type(screen.getByTestId('native-api-key'), 'sk-openai-test-key-000000')
      await userEvent.click(screen.getByTestId('native-continue'))
      await waitFor(() => expect(onConnected).toHaveBeenCalled())
      expect(onConnected.mock.calls[0]![0]).toBe('openai')
      expect(connectBody).toEqual({ apiKey: 'sk-openai-test-key-000000', provider: 'openai' })
    })
  })
})
