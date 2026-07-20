// OpenClawDefaultModel — the OpenClaw runtime's default-model picker in the
// Runtimes row's Manage body. Reads the current model from openclaw-config and
// PATCHes it on change. The two-layer ModelSelector dropdown is mocked here so
// the test isolates THIS component's wiring (fetch current + PATCH { model }).

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { OpenClawDefaultModel } from '../OpenClawDefaultModel'

vi.mock('@/features/maintenance/ModelSelector', () => ({
  ModelSelector: ({
    currentModel,
    onModelChange,
  }: {
    currentModel: string | null
    onModelChange: (m: string) => void
  }) => (
    <button
      data-testid="mock-model-selector"
      onClick={() => onModelChange('anthropic/claude-haiku-4-5')}
    >
      {currentModel ?? 'not set'}
    </button>
  ),
}))

afterEach(() => cleanup())

describe('OpenClawDefaultModel', () => {
  it('reflects the current OpenClaw default model from openclaw-config', async () => {
    server.use(
      http.get('/api/system/openclaw-config', () =>
        HttpResponse.json({
          config: {
            agents: { defaults: { model: { primary: 'openrouter/minimax/minimax-m2.5' } } },
          },
          env: {},
          version: null,
        }),
      ),
    )
    render(<OpenClawDefaultModel />)
    expect(await screen.findByTestId('openclaw-default-model')).toBeInTheDocument()
    expect(screen.getByTestId('mock-model-selector')).toHaveTextContent(
      'openrouter/minimax/minimax-m2.5',
    )
  })

  it('changing the model PATCHes openclaw-config with { model }', async () => {
    server.use(
      http.get('/api/system/openclaw-config', () =>
        HttpResponse.json({ config: {}, env: {}, version: null }),
      ),
    )
    const patched: unknown[] = []
    server.use(
      http.patch('/api/system/openclaw-config', async ({ request }) => {
        patched.push(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<OpenClawDefaultModel />)
    await userEvent.click(await screen.findByTestId('mock-model-selector'))
    await waitFor(() => expect(patched).toContainEqual({ model: 'anthropic/claude-haiku-4-5' }))
  })
})
