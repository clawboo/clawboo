// "Open on another device": the dashboard mints a one-time sign-in link (and a QR
// code for a phone) so nobody needs a terminal to open Clawboo somewhere else.
// The link carries a launch code, never the access token.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { server } from '@/__vitest__/mswServer'

import { deviceLink, isLoopbackHostname } from '../deviceLink'
import { OpenOnAnotherDeviceButton } from '../OpenOnAnotherDevice'
import { OpenOnAnotherDeviceDialog } from '../OpenOnAnotherDeviceDialog'

const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function mintsCodes(...codes: string[]) {
  const queue = [...codes]
  let calls = 0
  server.use(
    http.post('/api/access/launch-code', () => {
      calls += 1
      return HttpResponse.json({
        gated: true,
        code: queue.shift() ?? 'spent',
        expiresAt: Date.now() + 120_000,
        expiresInMs: 120_000,
      })
    }),
  )
  return { calls: () => calls }
}

describe('deviceLink', () => {
  it('puts the code in access_code on the page this dashboard is served from', () => {
    expect(deviceLink('http://192.168.1.5:18790', '', 'abc')).toBe(
      'http://192.168.1.5:18790/?access_code=abc',
    )
  })

  it('stays under a mount', () => {
    expect(deviceLink('https://dash.example.com', '/clawboo', 'abc')).toBe(
      'https://dash.example.com/clawboo/?access_code=abc',
    )
  })

  it('points a localhost page at 127.0.0.1, where the server listens', () => {
    // `localhost` can resolve to ::1, where another user's program could listen.
    expect(deviceLink('http://localhost:18790', '', 'abc')).toBe(
      'http://127.0.0.1:18790/?access_code=abc',
    )
  })

  it('is the plain page URL when there is no code', () => {
    expect(deviceLink('https://dash.example.com', '/clawboo', null)).toBe(
      'https://dash.example.com/clawboo/',
    )
  })
})

describe('isLoopbackHostname', () => {
  it('knows the names that only reach this computer', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'app.localhost']) {
      expect(isLoopbackHostname(host), host).toBe(true)
    }
    for (const host of ['192.168.1.5', 'dash.example.com', '10.0.0.2']) {
      expect(isLoopbackHostname(host), host).toBe(false)
    }
  })
})

describe('OpenOnAnotherDeviceButton', () => {
  it('opens the dialog and mints a code only when clicked', async () => {
    const minted = mintsCodes('code_one')
    render(<OpenOnAnotherDeviceButton />)
    expect(minted.calls()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /open on another device/i }))
    expect(
      await screen.findByRole('dialog', { name: /open on another device/i }),
    ).toBeInTheDocument()
    await waitFor(() => expect(minted.calls()).toBe(1))
  })
})

describe('OpenOnAnotherDeviceDialog on a network address', () => {
  const origin = 'http://192.168.1.5:18790'

  it('shows the one-time link and a QR code of it', async () => {
    mintsCodes('code_one')
    render(<OpenOnAnotherDeviceDialog open onClose={() => {}} origin={origin} />)
    const link = await screen.findByTestId('device-link')
    expect(link).toHaveTextContent('http://192.168.1.5:18790/?access_code=code_one')
    expect(screen.getByTestId('device-qr')).toBeInTheDocument()
    expect(screen.getByText(/works once/i)).toBeInTheDocument()
  })

  it('copies the link', async () => {
    mintsCodes('code_one')
    render(<OpenOnAnotherDeviceDialog open onClose={() => {}} origin={origin} />)
    await screen.findByTestId('device-link')
    fireEvent.click(screen.getByRole('button', { name: /copy link/i }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('http://192.168.1.5:18790/?access_code=code_one'),
    )
  })

  it('makes a new link on request', async () => {
    mintsCodes('code_one', 'code_two')
    render(<OpenOnAnotherDeviceDialog open onClose={() => {}} origin={origin} />)
    await screen.findByText(/code_one/)
    fireEvent.click(screen.getByRole('button', { name: /new link/i }))
    expect(await screen.findByText(/code_two/)).toBeInTheDocument()
  })

  it('says when the link has expired, and hides it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mintsCodes('code_one')
    render(<OpenOnAnotherDeviceDialog open onClose={() => {}} origin={origin} />)
    await screen.findByTestId('device-link')
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(await screen.findByText(/link has expired/i)).toBeInTheDocument()
    expect(screen.queryByTestId('device-qr')).not.toBeInTheDocument()
    expect(screen.queryByTestId('device-link')).not.toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    mintsCodes('code_one')
    const { container } = render(
      <OpenOnAnotherDeviceDialog open onClose={() => {}} origin={origin} />,
    )
    await screen.findByTestId('device-link')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('OpenOnAnotherDeviceDialog on this computer only', () => {
  it('says a phone cannot reach a localhost address, and shows no QR code', async () => {
    mintsCodes('code_one')
    render(<OpenOnAnotherDeviceDialog open onClose={() => {}} origin="http://localhost:18790" />)
    expect(await screen.findByTestId('device-link')).toHaveTextContent(
      'http://127.0.0.1:18790/?access_code=code_one',
    )
    expect(screen.getByText(/only on this computer/i)).toBeInTheDocument()
    expect(screen.queryByTestId('device-qr')).not.toBeInTheDocument()
  })
})

describe('OpenOnAnotherDeviceDialog on a server with no access token', () => {
  it('shows the plain address, since no sign-in is needed', async () => {
    server.use(http.post('/api/access/launch-code', () => HttpResponse.json({ gated: false })))
    render(<OpenOnAnotherDeviceDialog open onClose={() => {}} origin="http://192.168.1.5:18790" />)
    expect(await screen.findByTestId('device-link')).toHaveTextContent(
      /^http:\/\/192\.168\.1\.5:18790\/$/,
    )
    expect(screen.getByText(/no sign-in/i)).toBeInTheDocument()
  })
})

describe('OpenOnAnotherDeviceDialog when minting fails', () => {
  it('says so instead of showing a link', async () => {
    server.use(
      http.post('/api/access/launch-code', () =>
        HttpResponse.json({ error: 'Too many requests' }, { status: 429 }),
      ),
    )
    render(<OpenOnAnotherDeviceDialog open onClose={() => {}} origin="http://192.168.1.5:18790" />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not make a link/i)
    expect(screen.queryByTestId('device-link')).not.toBeInTheDocument()
  })
})
