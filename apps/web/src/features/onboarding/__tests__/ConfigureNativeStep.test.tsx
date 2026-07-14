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
    await waitFor(() =>
      expect(onConnected).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5'),
    )

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
})
