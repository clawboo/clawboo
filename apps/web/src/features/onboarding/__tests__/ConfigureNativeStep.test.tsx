// ConfigureNativeStep — paste a provider key, (optionally) test it, then continue
// to team selection. RTL pattern (msw onUnhandledRequest:'error' + jest-dom +
// userEvent). Two load-bearing assertions: the pasted key reaches ONLY the two
// routes entitled to it (the healthcheck, which never persists it, and connect,
// which vaults it) and never a response body; and Continue VERIFIES the
// credential before storing it, so a key that doesn't answer can't reach the
// vault without a deliberate "Continue anyway".
// This step no longer creates a team (real team selection is the next step); it
// records the chosen leader model so the universal Boo Zero runs on it.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ConfigureNativeStep } from '../steps/ConfigureNativeStep'

import { axe } from '@/__vitest__/axe'

afterEach(() => cleanup())

const SECRET = 'sk-ant-SECRET-DO-NOT-LEAK'

const HEALTHCHECK = '/api/runtimes/clawboo-native/healthcheck'
/** Continue now healthchecks before it connects, so every test that crosses that
 *  gate needs a verdict (msw runs with onUnhandledRequest:'error'). */
const healthcheckOk = () => http.post(HEALTHCHECK, () => HttpResponse.json({ ok: true }))
const healthcheckFails = (error: string) =>
  http.post(HEALTHCHECK, () => HttpResponse.json({ ok: false, error }))

describe('ConfigureNativeStep', () => {
  it('reveal toggle switches the key field between password and text', async () => {
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    // OpenAI (default) hides the key field behind ChatGPT sign-in; use a key provider.
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    const input = screen.getByTestId('native-api-key')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByLabelText('Show API key'))
    expect(input).toHaveAttribute('type', 'text')
  })

  it('selecting a provider marks its card checked (OpenAI is the default)', async () => {
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    // OpenAI leads the grid and is the default selection.
    expect(screen.getByTestId('native-provider-openai')).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    expect(screen.getByTestId('native-provider-anthropic')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('native-provider-openai')).toHaveAttribute('aria-checked', 'false')
  })

  it('shows a "Get a key" link that re-points per selected provider', async () => {
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    // OpenAI (the default) uses the ChatGPT sign-in — no key field. Pick a
    // key-based provider to exercise the "Get a key" link.
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
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
    // Selecting one activates it + deselects the default OpenAI card…
    await userEvent.click(groq)
    expect(groq).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('native-provider-openai')).toHaveAttribute('aria-checked', 'false')
    // …and re-points the "Get a key" link to that provider.
    expect(screen.getByTestId('native-get-key').getAttribute('href')).toContain('groq.com')
  })

  it('Test connection reports success when the key works', async () => {
    server.use(healthcheckOk())
    render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-test-connection'))
    expect(await screen.findByText('Key works')).toBeInTheDocument()
  })

  it('submit verifies then connects the key → onConnected(provider, model); the key never reaches the model-persist call or a response', async () => {
    const onConnected = vi.fn()
    let healthBody: Record<string, unknown> | null = null
    let connectBody: Record<string, unknown> | null = null
    let modelBody: Record<string, unknown> | null = null
    const responses: string[] = []

    server.use(
      http.post(HEALTHCHECK, async ({ request }) => {
        healthBody = (await request.json()) as Record<string, unknown>
        const body = { ok: true }
        responses.push(JSON.stringify(body))
        return HttpResponse.json(body)
      }),
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
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-continue'))

    // Advances with the connected provider + the chosen leader model (default =
    // the provider's strongest).
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5'))

    // The key rides exactly TWO requests — the healthcheck (which probes the
    // provider and persists nothing) and connect (which vaults it)…
    expect(healthBody).toEqual({ provider: 'anthropic', apiKey: SECRET })
    expect(connectBody).toEqual({ apiKey: SECRET, provider: 'anthropic' })
    // …but NEVER the model-persist request,…
    await waitFor(() => expect(modelBody).not.toBeNull())
    expect(JSON.stringify(modelBody)).not.toContain(SECRET)
    expect(modelBody).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })
    // …and NEVER any response body.
    for (const r of responses) expect(r).not.toContain(SECRET)
  })

  it('a key that does not verify blocks advancing and shows the reason inline', async () => {
    const onConnected = vi.fn()
    let connectCalled = false
    server.use(
      healthcheckFails('Invalid API key.'),
      http.post('/api/runtimes/clawboo-native/connect', () => {
        connectCalled = true
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-continue'))

    const alert = await screen.findByTestId('native-verify-failed')
    expect(alert).toHaveTextContent('Invalid API key.')
    // The whole point: a key that doesn't answer never reaches the vault, and the
    // wizard stays on the step where it can still be fixed.
    expect(connectCalled).toBe(false)
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('"Continue anyway" overrides a failed verification and connects', async () => {
    const onConnected = vi.fn()
    let connectBody: Record<string, unknown> | null = null
    let healthchecks = 0
    server.use(
      http.post(HEALTHCHECK, () => {
        healthchecks += 1
        return HttpResponse.json({ ok: false, error: 'Could not reach anthropic.' })
      }),
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        connectBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
      http.post('/api/onboarding/native-leader-model', () => HttpResponse.json({ ok: true })),
    )
    render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-continue'))
    await screen.findByTestId('native-verify-failed')

    await userEvent.click(screen.getByTestId('native-continue-anyway'))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5'))
    expect(connectBody).toEqual({ apiKey: SECRET, provider: 'anthropic' })
    // The override SKIPS the probe rather than re-running it — an offline user
    // shouldn't have to wait out a second 8-second timeout to get through.
    expect(healthchecks).toBe(1)
  })

  it('locks the configuration while verifying, so a mid-flight switch cannot mismatch what gets stored', async () => {
    // `handleSubmit` captures the provider/key/model before it awaits. Verification
    // can take up to 8s, so without this lock a user could switch provider mid-probe
    // and the callback would store + report the OLD provider while the UI showed the
    // NEW one. Hold the healthcheck open to sit inside that window deliberately.
    const onConnected = vi.fn()
    let connectBody: Record<string, unknown> | null = null
    let release: (() => void) | undefined
    server.use(
      http.post(HEALTHCHECK, async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return HttpResponse.json({ ok: true })
      }),
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        connectBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
      http.post('/api/onboarding/native-leader-model', () => HttpResponse.json({ ok: true })),
    )
    render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-continue'))

    // Mid-verification every configuration control is inert…
    await waitFor(() => expect(screen.getByTestId('native-provider-openrouter')).toBeDisabled())
    expect(screen.getByTestId('native-api-key')).toBeDisabled()
    expect(screen.getByTestId('native-more-providers-toggle')).toBeDisabled()

    // …so a click on another provider changes nothing.
    await userEvent.click(screen.getByTestId('native-provider-openrouter'))
    expect(screen.getByTestId('native-provider-anthropic')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('native-provider-openrouter')).toHaveAttribute(
      'aria-checked',
      'false',
    )

    release?.()
    // What was verified is exactly what is stored and reported.
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5'))
    expect(connectBody).toEqual({ apiKey: SECRET, provider: 'anthropic' })
  })

  it('an unreachable Ollama shows a start hint instead of advancing', async () => {
    const onConnected = vi.fn()
    let connectCalled = false
    server.use(
      healthcheckFails('Could not reach ollama.'),
      http.post('/api/runtimes/clawboo-native/connect', () => {
        connectCalled = true
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-provider-ollama'))
    await userEvent.click(screen.getByTestId('native-continue'))

    const alert = await screen.findByTestId('native-verify-failed')
    // Ollama is local, so the fix is "start it" — not "check your key".
    expect(alert).toHaveTextContent(/Ollama isn’t answering/i)
    expect(screen.getByText('ollama serve')).toBeInTheDocument()
    expect(screen.getByTestId('native-get-ollama')).toBeInTheDocument()
    expect(connectCalled).toBe(false)
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('skips the pre-advance probe when Test connection already passed for this key', async () => {
    const onConnected = vi.fn()
    let healthchecks = 0
    server.use(
      http.post(HEALTHCHECK, () => {
        healthchecks += 1
        return HttpResponse.json({ ok: true })
      }),
      http.post('/api/runtimes/clawboo-native/connect', () =>
        HttpResponse.json({ ok: true, connectionState: 'ready' }),
      ),
      http.post('/api/onboarding/native-leader-model', () => HttpResponse.json({ ok: true })),
    )
    render(<ConfigureNativeStep onConnected={onConnected} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-test-connection'))
    await screen.findByText('Key works')

    await userEvent.click(screen.getByTestId('native-continue'))
    await waitFor(() => expect(onConnected).toHaveBeenCalled())
    // One probe total: the verdict from Test connection stands, because every
    // keystroke and provider switch clears it.
    expect(healthchecks).toBe(1)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    await screen.findByTestId('configure-native-step')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no a11y violations in the failed-verification state', async () => {
    server.use(healthcheckFails('Invalid API key.'))
    const { container } = render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-provider-anthropic'))
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-continue'))
    await screen.findByTestId('native-verify-failed')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('Ollama card hides the key field and connects keyless once the daemon answers', async () => {
    const onConnected = vi.fn()
    let healthBody: Record<string, unknown> | null = null
    let connectBody: Record<string, unknown> | null = null
    server.use(
      http.post(HEALTHCHECK, async ({ request }) => {
        healthBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true })
      }),
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
    // The Ollama card has no Test-connection button, so Continue is the only place
    // "is it actually running?" gets asked — and it is asked, keylessly.
    expect(healthBody).toEqual({ provider: 'ollama', apiKey: '' })
    // Keyless: the client omits the empty apiKey entirely (the same wire form the
    // Runtimes panel's one-click provider reuse sends).
    expect(connectBody).toEqual({ provider: 'ollama' })
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
      // OpenAI is the DEFAULT provider now → the auth-method selector shows on
      // mount; a key-based provider (Anthropic) shows none.
      await userEvent.click(screen.getByTestId('native-provider-anthropic'))
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
      // Not signed in yet → the one-click sign-in shows (the manual command
      // lives inside the flow's failure states, not as standing chrome) and
      // Continue stays disabled.
      await screen.findByTestId('native-chatgpt-panel')
      expect(await screen.findByTestId('chatgpt-signin-codex-start')).toBeInTheDocument()
      expect(screen.getByTestId('native-continue')).toBeDisabled()
    })

    it('not-installed offers a button-driven Install (SSE) that chains into the sign-in state', async () => {
      let calls = 0
      server.use(
        http.get('/api/runtimes', () => {
          calls += 1
          // Before the install: the codex descriptor is present with
          // `installed: false` (the REAL "not installed" shape — the endpoint
          // always includes codex; it never drops it from the list). After: the
          // binary is installed but not signed in.
          return HttpResponse.json({
            runtimes: [
              calls > 1
                ? { id: 'codex', installed: true, connectionState: 'needs-login' }
                : { id: 'codex', installed: false, connectionState: 'not-installed' },
            ],
          })
        }),
        http.post(
          '/api/runtimes/codex/install',
          () =>
            new HttpResponse('data: {"type":"complete","success":true}\n\n', {
              headers: { 'Content-Type': 'text/event-stream' },
            }),
        ),
      )
      render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
      await userEvent.click(screen.getByTestId('native-provider-openai'))
      // The install affordance is a real button (+ the manual command as reference).
      expect(await screen.findByTestId('native-codex-install')).toBeInTheDocument()
      expect(screen.getByText('npm install -g @openai/codex')).toBeInTheDocument()
      expect(screen.getByTestId('native-continue')).toBeDisabled()

      // Install completes → re-probe → the one-click sign-in state.
      await userEvent.click(screen.getByTestId('native-codex-install'))
      expect(await screen.findByTestId('chatgpt-signin-codex-start')).toBeInTheDocument()
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

    it('a transient runtimes-probe failure on re-entry keeps the ready confirmation — never the alarming "install codex"', async () => {
      // Repro: reach ready → toggle to API key → back to ChatGPT (the effect
      // re-probes) → the re-probe FAILS (500 → fetchRuntimes returns []). The
      // empty list means "probe failed", NOT "codex uninstalled", so the ready
      // confirmation must be retained and the install prompt must never appear.
      let calls = 0
      server.use(
        http.get('/api/runtimes', () => {
          calls += 1
          return calls === 1
            ? HttpResponse.json({
                runtimes: [{ id: 'codex', installed: true, connectionState: 'ready' }],
              })
            : new HttpResponse(null, { status: 500 })
        }),
      )
      render(<ConfigureNativeStep onConnected={vi.fn()} onBack={vi.fn()} />)
      await userEvent.click(screen.getByTestId('native-provider-openai'))
      await screen.findByTestId('native-chatgpt-ready')
      await userEvent.click(screen.getByTestId('native-auth-api-key'))
      await userEvent.click(screen.getByTestId('native-auth-chatgpt'))
      // The failed re-probe must NOT collapse to the install prompt…
      await waitFor(() => expect(calls).toBeGreaterThan(1))
      expect(screen.queryByTestId('native-codex-install')).not.toBeInTheDocument()
      // …and the ready confirmation stays put.
      expect(screen.getByTestId('native-chatgpt-ready')).toBeInTheDocument()
    })

    it('Continue on a ready sign-in fires onConnected("codex", "") WITHOUT calling the native healthcheck, connect or model routes', async () => {
      const onConnected = vi.fn()
      let healthCalled = false
      let connectCalled = false
      let modelCalled = false
      server.use(
        codexRuntimes({ connectionState: 'ready' }),
        http.post(HEALTHCHECK, () => {
          healthCalled = true
          return HttpResponse.json({ ok: true })
        }),
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
      // The subscription IS the credential and the `ready` probe already verified
      // it — there is no key to check, so the key gate must stay out of this path.
      expect(healthCalled).toBe(false)
      expect(connectCalled).toBe(false)
      expect(modelCalled).toBe(false)
    })

    it('switching to the API key method restores the key flow (connects with provider "openai")', async () => {
      const onConnected = vi.fn()
      let connectBody: Record<string, unknown> | null = null
      server.use(
        codexRuntimes({ connectionState: 'needs-login' }),
        healthcheckOk(),
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
