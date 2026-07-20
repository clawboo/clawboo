// OpenClawGatewaySection — the OpenClaw Gateway process controls in the Runtimes
// row's Manage body. Reads /api/system/status for the live Running/Stopped + port
// and offers Restart (Start when the gateway died while the body is open). RTL +
// msw (onUnhandledRequest:'error').

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { OpenClawGatewaySection } from '../OpenClawGatewaySection'

afterEach(() => cleanup())

function statusHandler(gateway: { running: boolean; port: number; uptimeMs: number | null }): void {
  server.use(
    http.get('/api/system/status', () =>
      HttpResponse.json({
        node: { version: 'v22', major: 22, sufficient: true, path: '' },
        openclaw: {
          installed: true,
          version: '1',
          path: '',
          stateDir: '',
          configExists: true,
          envExists: true,
        },
        gateway: { ...gateway, pid: 1, managedByClawboo: true },
      }),
    ),
  )
}

describe('OpenClawGatewaySection', () => {
  it('running: shows Running + port + a Restart button (no Start)', async () => {
    statusHandler({ running: true, port: 18789, uptimeMs: 3_600_000 })
    render(<OpenClawGatewaySection />)
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.getByText(':18789')).toBeInTheDocument()
    expect(screen.getByTestId('openclaw-gateway-restart')).toBeInTheDocument()
    expect(screen.queryByTestId('openclaw-gateway-start')).toBeNull()
  })

  it('stopped: shows Stopped + a Start button (no Restart)', async () => {
    statusHandler({ running: false, port: 18789, uptimeMs: null })
    render(<OpenClawGatewaySection />)
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
    expect(screen.getByTestId('openclaw-gateway-start')).toBeInTheDocument()
    expect(screen.queryByTestId('openclaw-gateway-restart')).toBeNull()
  })

  it('Restart posts {action:"restart"} and re-probes the row via onChanged', async () => {
    statusHandler({ running: true, port: 18789, uptimeMs: null })
    const bodies: unknown[] = []
    server.use(
      http.post('/api/system/gateway', async ({ request }) => {
        bodies.push(await request.json())
        return new HttpResponse('data: {"type":"complete","success":true}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }),
    )
    const onChanged = vi.fn()
    render(<OpenClawGatewaySection onChanged={onChanged} />)
    await userEvent.click(await screen.findByTestId('openclaw-gateway-restart'))
    await waitFor(() => expect(bodies).toContainEqual({ action: 'restart' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
