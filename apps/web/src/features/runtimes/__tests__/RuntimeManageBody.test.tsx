// RuntimeManageBody — the inline Manage body's actions. Disconnect signs out per
// runtime: api-key → /disconnect, codex → /logout, openclaw → gateway stop. The
// confirm() dialog is mocked (the drawer-test precedent) so these unit tests
// drive the flow without the app-root <ConfirmDialog>.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { confirm } from '@/stores/confirm'
import { RuntimeManageBody } from '../RuntimeManageBody'

vi.mock('@/stores/confirm', async (orig) => ({
  ...(await orig<typeof import('@/stores/confirm')>()),
  confirm: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.mocked(confirm).mockReset()
})
beforeEach(() => {
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('RuntimeManageBody', () => {
  it('api-key runtime (hermes) → Disconnect POSTs /disconnect + re-probes', async () => {
    let hit = 0
    server.use(
      http.post('/api/runtimes/hermes/disconnect', () => {
        hit += 1
        return HttpResponse.json({ ok: true })
      }),
    )
    const onChanged = vi.fn()
    render(<RuntimeManageBody runtimeId="hermes" name="Hermes" onChanged={onChanged} />)
    await userEvent.click(screen.getByTestId('runtime-hermes-disconnect'))
    await waitFor(() => expect(hit).toBe(1))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('codex (oauth) → Disconnect POSTs /logout, never /disconnect', async () => {
    let logout = 0
    let disconnect = 0
    server.use(
      http.post('/api/runtimes/codex/logout', () => {
        logout += 1
        return HttpResponse.json({ ok: true })
      }),
      http.post('/api/runtimes/codex/disconnect', () => {
        disconnect += 1
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<RuntimeManageBody runtimeId="codex" name="Codex" onChanged={vi.fn()} />)
    await userEvent.click(screen.getByTestId('runtime-codex-disconnect'))
    await waitFor(() => expect(logout).toBe(1))
    expect(disconnect).toBe(0)
  })

  it('openclaw → Disconnect stops the gateway (POST /api/system/gateway {stop})', async () => {
    let stopped: unknown = null
    server.use(
      http.post('/api/system/gateway', async ({ request }) => {
        stopped = await request.json()
        return HttpResponse.json({ ok: true, stopped: true })
      }),
    )
    render(<RuntimeManageBody runtimeId="openclaw" name="OpenClaw" onChanged={vi.fn()} />)
    await userEvent.click(screen.getByTestId('runtime-openclaw-disconnect'))
    await waitFor(() => expect(stopped).toEqual({ action: 'stop' }))
  })

  it('cancelling the confirm does NOT disconnect', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    let hit = 0
    server.use(
      http.post('/api/runtimes/hermes/disconnect', () => {
        hit += 1
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<RuntimeManageBody runtimeId="hermes" name="Hermes" onChanged={vi.fn()} />)
    await userEvent.click(screen.getByTestId('runtime-hermes-disconnect'))
    await new Promise((r) => setTimeout(r, 20))
    expect(hit).toBe(0)
  })

  it('Details fires onDiagnostics; Re-check fires onChanged', async () => {
    const onDiagnostics = vi.fn()
    const onChanged = vi.fn()
    render(
      <RuntimeManageBody
        runtimeId="hermes"
        name="Hermes"
        onChanged={onChanged}
        onDiagnostics={onDiagnostics}
      />,
    )
    await userEvent.click(screen.getByTestId('runtime-hermes-details'))
    expect(onDiagnostics).toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('runtime-hermes-recheck'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
