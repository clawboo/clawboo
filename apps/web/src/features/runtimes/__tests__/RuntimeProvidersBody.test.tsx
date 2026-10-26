// RuntimeProvidersBody — the shared provider manager (native / OpenClaw / Hermes). RTL + msw
// (onUnhandledRequest:'error'). Connected-ONLY surface: hub-connected rows with
// one-click keyless "Use" reconnect, per-provider disconnect through the
// Providers-hub endpoint, the default-model dropdown + Make default, the honest
// codex-gated ChatGPT row, the add-more/empty CTAs that jump to Providers, and
// native's local Ollama (offered in settings, an ordinary connected row once set up).

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { confirm } from '@/stores/confirm'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { RuntimeProvidersBody } from '../RuntimeProvidersBody'

vi.mock('@/stores/confirm', async (orig) => ({
  ...(await orig<typeof import('@/stores/confirm')>()),
  confirm: vi.fn(),
}))

afterEach(() => {
  vi.mocked(confirm).mockReset()
  useSettingsModalStore.getState().close()
  cleanup()
})

function hub(connected: string[]): void {
  server.use(
    http.get('/api/providers', () =>
      HttpResponse.json({
        providers: connected.map((id) => ({ id, connected: true, poweredRuntimes: [] })),
      }),
    ),
  )
}

// "Use" verifies the STORED key before reconnecting on it (keyless — the route
// resolves the saved key itself), so it needs a verdict here.
const HEALTHCHECK = '/api/runtimes/clawboo-native/healthcheck'

describe('RuntimeProvidersBody', () => {
  it('renders ONLY hub-connected providers (space-efficient) + the add-more footer', async () => {
    hub(['openrouter'])
    render(<RuntimeProvidersBody nativeReady />)
    const or = await screen.findByTestId('native-provider-row-openrouter')
    expect(or).toHaveTextContent('Connected')
    // Not-connected providers are NOT listed — they're added in Providers.
    expect(screen.queryByTestId('native-provider-row-anthropic')).toBeNull()
    expect(screen.queryByTestId('native-provider-row-ollama')).toBeNull()
    // The ChatGPT row is codex-gated — absent when not signed in.
    expect(screen.queryByTestId('native-provider-row-chatgpt')).toBeNull()
    // The footer points at the ONE place keys are added.
    expect(screen.getByTestId('native-providers-open-hub')).toBeInTheDocument()
  })

  it('the add-more / empty CTA switches the Settings modal to the Providers view', async () => {
    hub([])
    render(<RuntimeProvidersBody nativeReady />)
    // Nothing connected → the empty card with the CTA.
    await screen.findByTestId('native-providers-empty')
    await userEvent.click(screen.getByTestId('native-providers-open-hub'))
    expect(useSettingsModalStore.getState().view).toBe('providers')
  })

  it('DISCONNECTED native: a hub-connected row offers one-click Use → verify the saved key, then the KEYLESS connect (provider only)', async () => {
    hub(['openrouter'])
    const posts: unknown[] = []
    let health: unknown = null
    server.use(
      http.post(HEALTHCHECK, async ({ request }) => {
        health = await request.json()
        return HttpResponse.json({ ok: true })
      }),
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        posts.push(await request.json())
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
    )
    const onChanged = vi.fn()
    render(<RuntimeProvidersBody nativeReady={false} onChanged={onChanged} />)
    await userEvent.click(await screen.findByTestId('native-provider-use-openrouter'))
    await waitFor(() => expect(posts).toContainEqual({ provider: 'openrouter' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    // Keyless both ways: the probe names the provider and lets the server read the
    // key it already holds — the key is never re-pasted, and never round-trips.
    expect(health).toEqual({ provider: 'openrouter', apiKey: '' })
  })

  it('a REVOKED stored key blocks the reconnect; "Use anyway" overrides it', async () => {
    hub(['openrouter'])
    const posts: unknown[] = []
    let healthchecks = 0
    server.use(
      http.post(HEALTHCHECK, () => {
        healthchecks += 1
        return HttpResponse.json({ ok: false, error: 'Invalid API key.' })
      }),
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        posts.push(await request.json())
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
    )
    const onChanged = vi.fn()
    render(<RuntimeProvidersBody nativeReady={false} onChanged={onChanged} />)
    await userEvent.click(await screen.findByTestId('native-provider-use-openrouter'))

    // "Connected" only ever meant "a key exists" — this is where we find out it
    // stopped working, instead of on the runtime's next run.
    expect(await screen.findByText(/OpenRouter: Invalid API key\./)).toBeInTheDocument()
    expect(posts).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('native-provider-use-anyway-openrouter'))
    await waitFor(() => expect(posts).toContainEqual({ provider: 'openrouter' }))
    expect(healthchecks).toBe(1)
  })

  it('READY native: the default provider shows the model dropdown; changing it saves the leader model', async () => {
    hub(['openrouter'])
    const saved: unknown[] = []
    server.use(
      http.get('/api/onboarding/native-leader-model', () =>
        HttpResponse.json({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }),
      ),
      http.post('/api/onboarding/native-leader-model', async ({ request }) => {
        saved.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
      http.get('/api/providers/openrouter/models', () =>
        HttpResponse.json({
          models: [
            { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku' },
            { id: 'minimax/minimax-m2.5', label: 'MiniMax: MiniMax M2.5' },
          ],
        }),
      ),
    )
    render(<RuntimeProvidersBody nativeReady />)
    const row = await screen.findByTestId('native-provider-row-openrouter')
    expect(row).toHaveTextContent('Default')
    await userEvent.click(screen.getByTestId('native-provider-toggle-openrouter'))
    // The live model list feeds the dropdown; pick MiniMax.
    await userEvent.click(await screen.findByTestId('native-provider-model-openrouter'))
    await userEvent.click(await screen.findByText('MiniMax: MiniMax M2.5'))
    await waitFor(() =>
      expect(saved).toContainEqual({ provider: 'openrouter', model: 'minimax/minimax-m2.5' }),
    )
  })

  it('READY native: a connected NON-default row offers Make default', async () => {
    hub(['openrouter', 'anthropic'])
    const saved: unknown[] = []
    server.use(
      http.get('/api/onboarding/native-leader-model', () =>
        HttpResponse.json({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }),
      ),
      http.post('/api/onboarding/native-leader-model', async ({ request }) => {
        saved.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<RuntimeProvidersBody nativeReady />)
    await userEvent.click(await screen.findByTestId('native-provider-toggle-anthropic'))
    await userEvent.click(await screen.findByTestId('native-provider-make-default-anthropic'))
    await waitFor(() =>
      expect(saved).toContainEqual(expect.objectContaining({ provider: 'anthropic' })),
    )
  })

  it('per-provider disconnect goes through the Providers-hub endpoint (confirm-gated)', async () => {
    hub(['openrouter'])
    vi.mocked(confirm).mockResolvedValue(true)
    const disconnects: string[] = []
    server.use(
      http.post('/api/providers/:id/disconnect', ({ params }) => {
        disconnects.push(String(params['id']))
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<RuntimeProvidersBody nativeReady />)
    await userEvent.click(await screen.findByTestId('native-provider-toggle-openrouter'))
    await userEvent.click(await screen.findByTestId('native-provider-disconnect-openrouter'))
    await waitFor(() => expect(disconnects).toEqual(['openrouter']))
  })

  it('OpenClaw variant: lists ANY connected hub provider, but no Use / default-model / ChatGPT affordances', async () => {
    // minimax is hub-only (not native-routable) — OpenClaw still shows it.
    hub(['openrouter', 'minimax'])
    render(<RuntimeProvidersBody runtime="openclaw" codexReady />)
    await screen.findByTestId('native-provider-row-openrouter')
    expect(screen.getByTestId('native-provider-row-minimax')).toBeInTheDocument()
    // Native-only affordances stay off this variant (OpenClaw manages its model
    // in openclaw.json; its subscription row lives in RuntimeManageBody).
    expect(screen.queryByTestId('native-provider-use-openrouter')).toBeNull()
    expect(screen.queryByTestId('native-provider-row-chatgpt')).toBeNull()
    expect(screen.queryByTestId('native-provider-ollama-offer')).toBeNull()
    await userEvent.click(screen.getByTestId('native-provider-toggle-openrouter'))
    expect(screen.queryByTestId('native-provider-model-openrouter')).toBeNull()
    expect(screen.queryByTestId('native-provider-make-default-openrouter')).toBeNull()
    // Per-provider disconnect is still there.
    expect(screen.getByTestId('native-provider-disconnect-openrouter')).toBeInTheDocument()
  })

  it('Hermes variant: only the keys its spawn plan can consume (openrouter + reused anthropic/openai)', async () => {
    hub(['openrouter', 'groq'])
    render(<RuntimeProvidersBody runtime="hermes" />)
    await screen.findByTestId('native-provider-row-openrouter')
    // groq is hub-connected but Hermes can't consume it — not listed here.
    expect(screen.queryByTestId('native-provider-row-groq')).toBeNull()
  })

  it('ONBOARDING variant is strictly READ-ONLY: connected rows only — no add affordance of any kind', async () => {
    hub(['openrouter'])
    render(<RuntimeProvidersBody variant="onboarding" nativeReady />)
    await screen.findByTestId('native-provider-row-openrouter')
    // A runtime surface never takes a new key: no hub link, no add chips, no
    // key input — connecting happens on the wizard's provider step (Back).
    expect(screen.queryByTestId('native-providers-open-hub')).toBeNull()
    expect(screen.queryByTestId('native-provider-add-groq')).toBeNull()
    expect(screen.queryByTestId('native-provider-row-groq')).toBeNull()
    expect(screen.queryByTestId('native-provider-ollama-offer')).toBeNull()
    expect(document.querySelector('input')).toBeNull()
    // The connected row still manages itself (default model + disconnect).
    await userEvent.click(screen.getByTestId('native-provider-toggle-openrouter'))
    expect(screen.getByTestId('native-provider-disconnect-openrouter')).toBeInTheDocument()
  })

  it('ONBOARDING variant with nothing to show renders NOTHING (no dead-end empty card)', async () => {
    hub([])
    const { container } = render(<RuntimeProvidersBody variant="onboarding" nativeReady />)
    await waitFor(() =>
      expect(container.querySelector('[data-testid="native-providers-body"]')).toBeNull(),
    )
    expect(screen.queryByTestId('native-providers-empty')).toBeNull()
  })

  // ── local Ollama (native only): picked HERE, since the hub has no key to hold ──
  it('Ollama not set up: settings offers it; Use checks the local daemon, then records the choice', async () => {
    hub(['openrouter'])
    let health: unknown = null
    const posts: unknown[] = []
    server.use(
      http.post(HEALTHCHECK, async ({ request }) => {
        health = await request.json()
        return HttpResponse.json({ ok: true })
      }),
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        posts.push(await request.json())
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
    )
    const onChanged = vi.fn()
    render(<RuntimeProvidersBody nativeReady onChanged={onChanged} />)
    expect(await screen.findByTestId('native-provider-ollama-offer')).toHaveTextContent(
      'Local · no key needed',
    )
    expect(screen.queryByTestId('native-provider-row-ollama')).toBeNull() // not connected yet
    await userEvent.click(screen.getByTestId('native-provider-use-ollama'))
    // Keyless both ways: the probe asks the local daemon, the connect sends only the pick.
    await waitFor(() => expect(posts).toEqual([{ provider: 'ollama' }]))
    expect(health).toEqual({ provider: 'ollama', apiKey: '' })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('a stopped Ollama blocks Use with the fix to run; "Use anyway" records the choice', async () => {
    hub([])
    const posts: unknown[] = []
    server.use(
      http.post(HEALTHCHECK, () =>
        HttpResponse.json({ ok: false, error: 'Could not reach ollama.' }),
      ),
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        posts.push(await request.json())
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
    )
    render(<RuntimeProvidersBody nativeReady={false} />)
    // Nothing connected yet: the empty card, and Ollama offered beside it.
    await screen.findByTestId('native-providers-empty')
    await userEvent.click(await screen.findByTestId('native-provider-use-ollama'))
    expect(await screen.findByText(/ollama serve/)).toBeInTheDocument()
    expect(posts).toEqual([])
    await userEvent.click(screen.getByTestId('native-provider-use-anyway-ollama'))
    await waitFor(() => expect(posts).toEqual([{ provider: 'ollama' }]))
  })

  it('Ollama set up: an ordinary connected row; Disconnect removes ONLY the Ollama choice', async () => {
    hub(['openrouter'])
    vi.mocked(confirm).mockResolvedValue(true)
    const scoped: unknown[] = []
    const hubDisconnects: string[] = []
    server.use(
      http.post('/api/runtimes/clawboo-native/disconnect', async ({ request }) => {
        scoped.push(await request.json())
        return HttpResponse.json({ ok: true, connectionState: 'ready' })
      }),
      http.post('/api/providers/:id/disconnect', ({ params }) => {
        hubDisconnects.push(String(params['id']))
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<RuntimeProvidersBody nativeReady ollamaConnected />)
    expect(await screen.findByTestId('native-provider-row-ollama')).toHaveTextContent('Connected')
    expect(screen.queryByTestId('native-provider-ollama-offer')).toBeNull()
    await userEvent.click(screen.getByTestId('native-provider-toggle-ollama'))
    await userEvent.click(screen.getByTestId('native-provider-disconnect-ollama'))
    // The native runtime's own provider-scoped disconnect, never the hub's key removal.
    await waitFor(() => expect(scoped).toEqual([{ provider: 'ollama' }]))
    expect(hubDisconnects).toEqual([])
  })

  it('Ollama set up: Make default records an ollama leader model', async () => {
    hub([])
    const saved: unknown[] = []
    server.use(
      http.post('/api/onboarding/native-leader-model', async ({ request }) => {
        saved.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<RuntimeProvidersBody nativeReady ollamaConnected />)
    await userEvent.click(await screen.findByTestId('native-provider-toggle-ollama'))
    await userEvent.click(screen.getByTestId('native-provider-make-default-ollama'))
    await waitFor(() => expect(saved).toEqual([{ provider: 'ollama', model: 'llama3.2' }]))
  })

  // ── Ollama's model list is what the local daemon has pulled ───────────────
  // The default model used to be a static llama3.2; an Ollama that never pulled
  // it failed every run while this row read Connected.

  function ollamaLeader(model: string) {
    return http.get('/api/onboarding/native-leader-model', () =>
      HttpResponse.json({ provider: 'ollama', model }),
    )
  }
  function ollamaModels(body: Record<string, unknown>, onCall?: () => void) {
    return http.get('/api/providers/ollama/models', () => {
      onCall?.()
      return HttpResponse.json(body)
    })
  }
  const PULLED = {
    models: [
      { id: 'qwen2.5:7b', label: 'qwen2.5:7b' },
      { id: 'mistral', label: 'mistral' },
    ],
    reachable: true,
    recommendedModel: 'qwen2.5:7b',
  }

  it('Ollama default: the dropdown lists the pulled models, and asks only once the row opens', async () => {
    hub([])
    let calls = 0
    server.use(
      ollamaLeader('qwen2.5:7b'),
      ollamaModels(PULLED, () => (calls += 1)),
    )
    render(<RuntimeProvidersBody nativeReady ollamaConnected />)
    await screen.findByTestId('native-provider-row-ollama')
    expect(calls).toBe(0)
    await userEvent.click(screen.getByTestId('native-provider-toggle-ollama'))
    await waitFor(() => expect(calls).toBe(1))
    const select = await screen.findByTestId('native-provider-model-ollama')
    expect(select).toHaveTextContent('qwen2.5:7b')
    await userEvent.click(select)
    expect(screen.getByRole('option', { name: 'mistral' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /llama/i })).toBeNull()
    // The default is pulled, so there is nothing to fix.
    expect(screen.queryByTestId('native-provider-ollama-notice')).toBeNull()
  })

  it('Ollama default not pulled: says so with the pull command and never shows another model as the default', async () => {
    hub([])
    let calls = 0
    server.use(
      ollamaLeader('llama3.2'),
      ollamaModels(PULLED, () => (calls += 1)),
    )
    render(<RuntimeProvidersBody nativeReady ollamaConnected />)
    await userEvent.click(await screen.findByTestId('native-provider-toggle-ollama'))
    const notice = await screen.findByTestId('native-provider-ollama-notice')
    expect(notice).toHaveTextContent(/doesn't have llama3\.2/)
    expect(notice).toHaveTextContent('ollama pull llama3.2')
    // The stored model, marked, rather than the first pulled one passing for it.
    expect(screen.getByTestId('native-provider-model-ollama')).toHaveTextContent(
      'llama3.2 (not pulled)',
    )
    await userEvent.click(screen.getByTestId('native-provider-ollama-check-again'))
    await waitFor(() => expect(calls).toBe(2))
  })

  it('Ollama with no chat model: the notice offers a model to pull', async () => {
    hub([])
    server.use(
      ollamaLeader('llama3.2'),
      ollamaModels({ models: [], reachable: true, recommendedModel: 'llama3.2' }),
    )
    render(<RuntimeProvidersBody nativeReady ollamaConnected />)
    await userEvent.click(await screen.findByTestId('native-provider-toggle-ollama'))
    const notice = await screen.findByTestId('native-provider-ollama-notice')
    expect(notice).toHaveTextContent(/no chat model/i)
    expect(notice).toHaveTextContent('ollama pull llama3.2')
  })

  it('a stopped Ollama: the notice says to start it', async () => {
    hub([])
    server.use(
      ollamaLeader('qwen2.5:7b'),
      ollamaModels({ models: [], reachable: false, recommendedModel: 'llama3.2' }),
    )
    render(<RuntimeProvidersBody nativeReady ollamaConnected />)
    await userEvent.click(await screen.findByTestId('native-provider-toggle-ollama'))
    const notice = await screen.findByTestId('native-provider-ollama-notice')
    expect(notice).toHaveTextContent(/isn't answering/)
    expect(notice).toHaveTextContent('ollama serve')
    // Unknown is not "missing": the stored model, without the mark.
    expect(screen.getByTestId('native-provider-model-ollama')).toHaveTextContent('qwen2.5:7b')
    expect(screen.getByTestId('native-provider-model-ollama')).not.toHaveTextContent('not pulled')
  })

  it('Ollama Make default records the pulled model a new agent would get', async () => {
    hub([])
    const saved: unknown[] = []
    server.use(
      ollamaModels(PULLED),
      http.post('/api/onboarding/native-leader-model', async ({ request }) => {
        saved.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<RuntimeProvidersBody nativeReady ollamaConnected />)
    await userEvent.click(await screen.findByTestId('native-provider-toggle-ollama'))
    await userEvent.click(screen.getByTestId('native-provider-make-default-ollama'))
    await waitFor(() => expect(saved).toEqual([{ provider: 'ollama', model: 'qwen2.5:7b' }]))
  })

  it('ONBOARDING variant lists a set-up Ollama as a connected row', async () => {
    hub([])
    render(<RuntimeProvidersBody variant="onboarding" nativeReady ollamaConnected />)
    expect(await screen.findByTestId('native-provider-row-ollama')).toHaveTextContent('Connected')
    expect(screen.queryByTestId('native-provider-ollama-offer')).toBeNull()
  })

  it('the ChatGPT row appears (Connected · Codex) only when the subscription is signed in', async () => {
    hub([])
    render(<RuntimeProvidersBody nativeReady codexReady />)
    expect(await screen.findByTestId('native-provider-row-chatgpt')).toHaveTextContent(
      'Connected · Codex',
    )
    // With the subscription connected, the surface isn't "empty".
    expect(screen.queryByTestId('native-providers-empty')).toBeNull()
  })

  // The ChatGPT subscription for a CONSUMING runtime (openclaw / hermes) is a peer
  // row in the providers list, never a special card above it.
  it('subscription row (openclaw) — CONNECTED shows a chip, no sign-in', async () => {
    hub(['openrouter'])
    render(
      <RuntimeProvidersBody
        runtime="openclaw"
        subscriptionTool="openclaw"
        subscriptionConnected
        codexReady
      />,
    )
    expect(await screen.findByTestId('runtime-openclaw-subscription-connected')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-openclaw-subscription-add')).toBeNull()
    expect(screen.queryByTestId('chatgpt-signin-openclaw-start')).toBeNull()
  })

  it('subscription row (openclaw) — ADDABLE (Codex ready, not yet added) shows the inline sign-in', async () => {
    hub(['openrouter'])
    render(
      <RuntimeProvidersBody
        runtime="openclaw"
        subscriptionTool="openclaw"
        subscriptionConnected={false}
        subscriptionLoginCommand="openclaw models auth login --provider openai-codex"
        codexReady
      />,
    )
    expect(await screen.findByTestId('runtime-openclaw-subscription-add')).toBeInTheDocument()
    expect(screen.getByTestId('chatgpt-signin-openclaw-start')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-openclaw-subscription-connected')).toBeNull()
  })

  it('subscription row (openclaw) — Codex NOT connected shows a quiet prerequisite, no sign-in', async () => {
    hub(['openrouter'])
    render(
      <RuntimeProvidersBody
        runtime="openclaw"
        subscriptionTool="openclaw"
        subscriptionConnected={false}
      />,
    )
    expect(
      await screen.findByTestId('runtime-openclaw-subscription-needs-codex'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-openclaw-subscription-add')).toBeNull()
    expect(screen.queryByTestId('chatgpt-signin-openclaw-start')).toBeNull()
  })

  it('subscription row shows even with NO key providers connected (it IS a provider option)', async () => {
    hub([])
    render(
      <RuntimeProvidersBody
        runtime="openclaw"
        subscriptionTool="openclaw"
        subscriptionConnected
        codexReady
      />,
    )
    expect(await screen.findByTestId('runtime-openclaw-subscription-connected')).toBeInTheDocument()
    expect(screen.queryByTestId('native-providers-empty')).toBeNull()
  })
})
