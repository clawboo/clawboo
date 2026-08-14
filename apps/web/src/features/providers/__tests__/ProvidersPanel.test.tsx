import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { server } from '@/__vitest__/mswServer'
import { ProvidersPanel } from '../ProvidersPanel'

// Save verifies the pasted key against its provider before storing it, so the
// save-path tests need a verdict (msw runs with onUnhandledRequest:'error').
const HEALTHCHECK = '/api/runtimes/clawboo-native/healthcheck'

/** The row card for a provider by display name (order-agnostic). */
async function rowFor(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name)).closest('.rounded-2xl') as HTMLElement
}

describe('ProvidersPanel', () => {
  it('renders provider rows and reflects connected status', async () => {
    server.use(
      http.get('/api/providers', () =>
        HttpResponse.json({
          providers: [
            {
              id: 'anthropic',
              connected: true,
              poweredRuntimes: ['Clawboo Native', 'Claude Code', 'OpenClaw'],
            },
          ],
        }),
      ),
    )
    render(<ProvidersPanel />)
    expect(await screen.findByText('Anthropic')).toBeInTheDocument()
    // The connected provider shows a "Connected" pill; a not-connected one is present too.
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
  })

  it('Connect reveals the key input for a provider', async () => {
    server.use(http.get('/api/providers', () => HttpResponse.json({ providers: [] })))
    render(<ProvidersPanel />)
    // Target Anthropic's OWN Connect button (order-agnostic — the catalog leads
    // with OpenAI/OpenRouter now, so "the first Connect" is no longer Anthropic).
    const anthropicRow = await rowFor('Anthropic')
    fireEvent.click(within(anthropicRow).getByRole('button', { name: 'Connect' }))
    // The editing row appears (Save button + the masked key input).
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeInTheDocument()
  })

  it('Save verifies the key before storing it', async () => {
    const saved: unknown[] = []
    let health: unknown = null
    server.use(
      http.get('/api/providers', () => HttpResponse.json({ providers: [] })),
      http.post(HEALTHCHECK, async ({ request }) => {
        health = await request.json()
        return HttpResponse.json({ ok: true })
      }),
      http.post('/api/providers/anthropic/connect', async ({ request }) => {
        saved.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<ProvidersPanel />)
    const row = await rowFor('Anthropic')
    await userEvent.click(within(row).getByRole('button', { name: 'Connect' }))
    await userEvent.type(screen.getByPlaceholderText('sk-ant-…'), 'sk-ant-good')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saved).toEqual([{ apiKey: 'sk-ant-good' }]))
    expect(health).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-good' })
  })

  it('a key that does not verify is not stored; "Save anyway" overrides it', async () => {
    const saved: unknown[] = []
    let healthchecks = 0
    server.use(
      http.get('/api/providers', () => HttpResponse.json({ providers: [] })),
      http.post(HEALTHCHECK, () => {
        healthchecks += 1
        return HttpResponse.json({ ok: false, error: 'Invalid API key.' })
      }),
      http.post('/api/providers/anthropic/connect', async ({ request }) => {
        saved.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<ProvidersPanel />)
    const row = await rowFor('Anthropic')
    await userEvent.click(within(row).getByRole('button', { name: 'Connect' }))
    await userEvent.type(screen.getByPlaceholderText('sk-ant-…'), 'sk-ant-bad')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The reason stays next to the field that fixes it, and nothing was stored.
    const failure = await screen.findByTestId('provider-anthropic-verify-failed')
    expect(failure).toHaveTextContent('Invalid API key.')
    expect(saved).toEqual([])
    // The row stays in edit mode so the key is still there to correct.
    expect(screen.getByPlaceholderText('sk-ant-…')).toHaveValue('sk-ant-bad')

    await userEvent.click(screen.getByTestId('provider-anthropic-save-anyway'))
    await waitFor(() => expect(saved).toEqual([{ apiKey: 'sk-ant-bad' }]))
    expect(healthchecks).toBe(1)
  })

  it('a provider with no probe saves unchecked rather than blocking on a check we cannot run', async () => {
    // Venice is mirrored to OpenClaw but isn't one of the native runtime's routable
    // providers, so the healthcheck has no endpoint for it. Refusing to save would
    // be worse than saving unverified — msw's onUnhandledRequest:'error' proves no
    // probe is even attempted.
    const saved: unknown[] = []
    server.use(
      http.get('/api/providers', () => HttpResponse.json({ providers: [] })),
      http.post('/api/providers/venice/connect', async ({ request }) => {
        saved.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<ProvidersPanel />)
    // Venice lives in the collapsed "more" tier.
    await userEvent.click(await screen.findByRole('button', { name: /More providers/ }))
    const row = await rowFor('Venice')
    await userEvent.click(within(row).getByRole('button', { name: 'Connect' }))
    await userEvent.type(screen.getByPlaceholderText('vapi_…'), 'vapi_abc')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toEqual([{ apiKey: 'vapi_abc' }]))
  })

  it('the ChatGPT-subscription row: Connect expands the one-click sign-in (no key input)', async () => {
    server.use(
      http.get('/api/providers', () => HttpResponse.json({ providers: [] })),
      http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [] })),
    )
    render(<ProvidersPanel />)
    const row = await screen.findByTestId('provider-row-chatgpt')
    expect(row).toHaveTextContent('ChatGPT subscription')
    expect(row).toHaveTextContent(/no API key/i)
    fireEvent.click(screen.getByTestId('provider-chatgpt-connect'))
    // The sign-in flow, not a key field.
    expect(await screen.findByTestId('chatgpt-signin-codex-start')).toBeInTheDocument()
    expect(row.querySelector('input')).toBeNull()
  })

  it('the ChatGPT-subscription row reads Connected from the codex runtime state', async () => {
    server.use(
      http.get('/api/providers', () => HttpResponse.json({ providers: [] })),
      http.get('/api/runtimes', () =>
        HttpResponse.json({
          runtimes: [{ id: 'codex', installed: true, connectionState: 'ready' }],
        }),
      ),
    )
    render(<ProvidersPanel />)
    const row = await screen.findByTestId('provider-row-chatgpt')
    expect(row).toHaveTextContent('Connected')
    // No Connect demand once connected; the credential is the Codex CLI's.
    expect(row).toHaveTextContent(/Managed by the Codex CLI/i)
  })
})
