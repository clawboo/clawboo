// ConfigureStep (OpenClaw provider + key) — the OpenAI card's ChatGPT-subscription
// method. Mirrors ConfigureNativeStep's selector tests: the method is DEFAULT on
// the OpenAI card, Continue gates on a verified OpenClaw sign-in (its OWN
// `openai-codex` oauth profile — a codex-CLI login alone is only the offer), and
// the submit posts the KEYLESS `openai-codex` provider. The login itself is
// terminal-only (never automated).

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ConfigureStep } from '../steps/ConfigureStep'

afterEach(() => cleanup())

const codexAuthHandler = (over: Partial<Record<string, unknown>> = {}) =>
  http.get('/api/system/openclaw-config', () =>
    HttpResponse.json({
      config: null,
      env: {},
      version: '2026.5.27',
      codexAuth: {
        profile: false,
        codexCli: false,
        bootstrapTrusted: false,
        loginCommand: 'openclaw models auth login --provider openai-codex',
        ...over,
      },
    }),
  )

describe('ConfigureStep — Sign in with ChatGPT (OpenAI card)', () => {
  it('shows the method selector ONLY on the OpenAI card, ChatGPT default + Recommended chip', async () => {
    server.use(codexAuthHandler())
    render(<ConfigureStep onConfigured={vi.fn()} onBack={vi.fn()} />)
    // No provider picked → no selector.
    expect(screen.queryByTestId('openclaw-auth-chatgpt')).not.toBeInTheDocument()

    // Anthropic → still no selector (it's an API-key provider only).
    await userEvent.click(screen.getByRole('radio', { name: /Anthropic/ }))
    expect(screen.queryByTestId('openclaw-auth-chatgpt')).not.toBeInTheDocument()

    // OpenAI → the 2-card selector, ChatGPT pre-selected + Recommended.
    await userEvent.click(screen.getByRole('radio', { name: /OpenAI/ }))
    expect(screen.getByTestId('openclaw-auth-chatgpt')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('openclaw-auth-api-key')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    // The key input is the api-key method's UI — hidden on the ChatGPT method
    // (waitFor: the Anthropic-era input exits via AnimatePresence).
    await waitFor(() =>
      expect(screen.queryByLabelText('OpenClaw provider API key')).not.toBeInTheDocument(),
    )
  })

  it('gates Continue on the OPENCLAW profile (a codex-CLI login alone only offers the path)', async () => {
    server.use(codexAuthHandler({ codexCli: true, profile: false }))
    render(<ConfigureStep onConfigured={vi.fn()} onBack={vi.fn()} />)
    await userEvent.click(screen.getByRole('radio', { name: /OpenAI/ }))

    const panel = await screen.findByTestId('openclaw-chatgpt-panel')
    // The codexCli signal shapes the copy (OpenClaw needs its OWN sign-in)…
    expect(panel).toHaveTextContent(/OpenClaw needs its own quick sign-in/i)
    // …with the one-click sign-in (the NON-destructive login command lives in
    // the flow's failure states, never as standing chrome — and never onboard).
    expect(screen.getByTestId('chatgpt-signin-openclaw-start')).toBeInTheDocument()
    // Continue stays disabled — bootstrapTrusted is false, so codexCli ≠ ready.
    expect(screen.getByRole('button', { name: /Configure & Start/ })).toBeDisabled()
  })

  it('Re-check flips to ready once the profile exists; submit posts KEYLESS openai-codex + the codex model', async () => {
    let calls = 0
    let configureBody: Record<string, unknown> | null = null
    server.use(
      http.get('/api/system/openclaw-config', () => {
        calls += 1
        return HttpResponse.json({
          config: null,
          env: {},
          version: '2026.5.27',
          codexAuth: {
            profile: calls > 1, // ready after the user runs the login + re-checks
            codexCli: true,
            bootstrapTrusted: false,
            loginCommand: 'openclaw models auth login --provider openai-codex',
          },
        })
      }),
      http.post('/api/system/configure-openclaw', async ({ request }) => {
        configureBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, gatewayUrl: 'ws://localhost:18789' })
      }),
    )
    const onConfigured = vi.fn()
    render(<ConfigureStep onConfigured={onConfigured} onBack={vi.fn()} />)
    await userEvent.click(screen.getByRole('radio', { name: /OpenAI/ }))
    await userEvent.click(await screen.findByTestId('openclaw-chatgpt-recheck'))
    await screen.findByTestId('openclaw-chatgpt-ready')

    await userEvent.click(screen.getByRole('button', { name: /Configure & Start/ }))
    await waitFor(() =>
      expect(onConfigured).toHaveBeenCalledWith({ gatewayUrl: 'ws://localhost:18789' }),
    )
    // The keyless subscription provider + its default model; NO apiKey field.
    expect(configureBody).toEqual({ provider: 'openai-codex', model: 'openai-codex/gpt-5.5' })
  })

  it('the API key method still works (switch → key input → posts provider openai + the key)', async () => {
    let configureBody: Record<string, unknown> | null = null
    server.use(
      codexAuthHandler(),
      http.post('/api/system/configure-openclaw', async ({ request }) => {
        configureBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, gatewayUrl: 'ws://localhost:18789' })
      }),
    )
    render(<ConfigureStep onConfigured={vi.fn()} onBack={vi.fn()} />)
    await userEvent.click(screen.getByRole('radio', { name: /OpenAI/ }))
    await userEvent.click(screen.getByTestId('openclaw-auth-api-key'))
    expect(screen.queryByTestId('openclaw-chatgpt-panel')).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('OpenClaw provider API key'), 'sk-openai-key-000')
    await userEvent.click(screen.getByRole('button', { name: /Configure & Start/ }))
    await waitFor(() => expect(configureBody).not.toBeNull())
    expect(configureBody!['provider']).toBe('openai')
    expect(configureBody!['apiKey']).toBe('sk-openai-key-000')
  })
})
