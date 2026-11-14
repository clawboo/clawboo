// A link's page: the token comes from the fragment, leaves the address bar at
// once, and travels only in a header.

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clawboo/control-client', () => ({
  apiUrl: (p: string) => p,
  apiFetch: (p: string, init?: RequestInit) => fetch(p, init),
}))
vi.mock('../ComputerScreen', () => ({
  ComputerScreen: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="screen">{readOnly ? 'watch only' : 'can control'}</div>
  ),
}))

const { ComputerLinkPage } = await import('../ComputerLinkPage')

const TOKEN = 'cbcl_' + 'A'.repeat(43)
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.history.replaceState(null, '', `/computer-link#${TOKEN}`)
  fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          kind: 'view',
          expiresAt: Date.now() + 1000,
          agent: { name: 'Research Boo' },
        }),
        { status: 200 },
      ),
  )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('ComputerLinkPage', () => {
  it('takes the token out of the address bar and sends it only in a header', async () => {
    render(<ComputerLinkPage />)
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/computer-link/info')
    expect(url).not.toContain(TOKEN)
    expect((init.headers as Record<string, string>)['x-clawboo-computer-link']).toBe(TOKEN)
    expect(init.credentials).toBe('omit')
    expect(await screen.findByText("Research Boo's screen")).toBeTruthy()
    // A view link watches only.
    expect(screen.getByTestId('screen').textContent).toBe('watch only')
  })

  it('says a link without a token is incomplete, and asks for nothing', () => {
    window.history.replaceState(null, '', '/computer-link')
    render(<ComputerLinkPage />)
    expect(screen.getByText('This link is incomplete.')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
