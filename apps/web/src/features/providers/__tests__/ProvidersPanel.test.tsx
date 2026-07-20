import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'

import { server } from '@/__vitest__/mswServer'
import { ProvidersPanel } from '../ProvidersPanel'

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
    const anthropicRow = (await screen.findByText('Anthropic')).closest(
      '.rounded-2xl',
    ) as HTMLElement
    fireEvent.click(within(anthropicRow).getByRole('button', { name: 'Connect' }))
    // The editing row appears (Save button + the masked key input).
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeInTheDocument()
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
