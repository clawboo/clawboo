// RuntimeProvidersBody — the shared provider manager (native / OpenClaw / Hermes). RTL + msw
// (onUnhandledRequest:'error'). Connected-ONLY surface: hub-connected rows with
// one-click keyless "Use" reconnect, per-provider disconnect through the
// Providers-hub endpoint, the default-model dropdown + Make default, the honest
// codex-gated ChatGPT row, and the add-more/empty CTAs that jump to Providers.

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

  it('DISCONNECTED native: a hub-connected row offers one-click Use → the KEYLESS connect (provider only)', async () => {
    hub(['openrouter'])
    const posts: unknown[] = []
    server.use(
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
