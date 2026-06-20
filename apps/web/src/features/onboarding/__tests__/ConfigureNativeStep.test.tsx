// ConfigureNativeStep — paste a provider key, (optionally) test it, then seed a
// starter team. RTL pattern (msw onUnhandledRequest:'error' + jest-dom +
// userEvent). The load-bearing assertion: the pasted key is written via the
// connect route ONLY and never propagates to the seed request or any response.

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
    render(<ConfigureNativeStep onSeeded={vi.fn()} onBack={vi.fn()} />)
    const input = screen.getByTestId('native-api-key')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByLabelText('Show API key'))
    expect(input).toHaveAttribute('type', 'text')
  })

  it('selecting a provider marks its pill pressed', async () => {
    render(<ConfigureNativeStep onSeeded={vi.fn()} onBack={vi.fn()} />)
    expect(screen.getByTestId('native-provider-anthropic')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByTestId('native-provider-openai'))
    expect(screen.getByTestId('native-provider-openai')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('native-provider-anthropic')).toHaveAttribute('aria-pressed', 'false')
  })

  it('Test connection reports success when the key works', async () => {
    server.use(
      http.post('/api/runtimes/clawboo-native/healthcheck', () => HttpResponse.json({ ok: true })),
    )
    render(<ConfigureNativeStep onSeeded={vi.fn()} onBack={vi.fn()} />)
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-test-connection'))
    expect(await screen.findByText('Key works')).toBeInTheDocument()
  })

  it('submit connects the key + seeds a team → onSeeded(teamId); the key never reaches the seed call or a response', async () => {
    const onSeeded = vi.fn()
    let connectBody: Record<string, unknown> | null = null
    let seedBody: Record<string, unknown> | null = null
    const responses: string[] = []

    server.use(
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        connectBody = (await request.json()) as Record<string, unknown>
        const body = { ok: true, connectionState: 'ready' }
        responses.push(JSON.stringify(body))
        return HttpResponse.json(body)
      }),
      http.post('/api/onboarding/seed-native-team', async ({ request }) => {
        seedBody = (await request.json()) as Record<string, unknown>
        const body = {
          teamId: 'team-1',
          leaderAgentId: 'native-lead',
          specialistAgentId: 'native-coder',
        }
        responses.push(JSON.stringify(body))
        return HttpResponse.json(body, { status: 201 })
      }),
    )

    render(<ConfigureNativeStep onSeeded={onSeeded} onBack={vi.fn()} />)
    await userEvent.type(screen.getByTestId('native-api-key'), SECRET)
    await userEvent.click(screen.getByTestId('native-create-team'))

    await waitFor(() => expect(onSeeded).toHaveBeenCalledWith('team-1'))

    // The key rides the connect request (its single legitimate destination)…
    expect(connectBody).toEqual({ apiKey: SECRET, provider: 'anthropic' })
    // …but NEVER the seed request,…
    expect(JSON.stringify(seedBody)).not.toContain(SECRET)
    expect(seedBody).toEqual({ provider: 'anthropic' })
    // …and NEVER any response body.
    for (const r of responses) expect(r).not.toContain(SECRET)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<ConfigureNativeStep onSeeded={vi.fn()} onBack={vi.fn()} />)
    await screen.findByTestId('configure-native-step')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })

  it('Ollama expander hides the key field and submits keyless', async () => {
    const onSeeded = vi.fn()
    let connectBody: Record<string, unknown> | null = null
    server.use(
      http.post('/api/runtimes/clawboo-native/connect', async ({ request }) => {
        connectBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ ok: true, connectionState: 'needs-auth' })
      }),
      http.post('/api/onboarding/seed-native-team', () =>
        HttpResponse.json({ teamId: 'team-ollama' }, { status: 201 }),
      ),
    )
    render(<ConfigureNativeStep onSeeded={onSeeded} onBack={vi.fn()} />)
    await userEvent.click(screen.getByTestId('native-ollama-toggle'))
    expect(screen.queryByTestId('native-api-key')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('native-create-team'))
    await waitFor(() => expect(onSeeded).toHaveBeenCalledWith('team-ollama'))
    expect(connectBody).toEqual({ apiKey: '', provider: 'ollama' })
  })
})
