import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    await screen.findByText('Anthropic')
    const connectButtons = await screen.findAllByRole('button', { name: 'Connect' })
    fireEvent.click(connectButtons[0]!)
    // The editing row appears (Save button + the masked key input).
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeInTheDocument()
  })
})
