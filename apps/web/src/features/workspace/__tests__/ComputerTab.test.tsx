// The Computer tab opens on the agent's screen while it has one, else on its
// files, and switches between them.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const status = vi.hoisted(() => ({ body: {} as Record<string, unknown> }))

const posted = vi.hoisted(() => [] as string[])
vi.mock('@clawboo/control-client', () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(path)
      return new Response('{"ok":true}', { status: 200 })
    }
    return new Response(JSON.stringify(status.body), { status: 200 })
  },
}))
vi.mock('../WorkspacePanel', () => ({ WorkspacePanel: () => <div>files view</div> }))
vi.mock('@/features/computer/ComputerScreen', () => ({
  ComputerScreen: () => <div>screen view</div>,
}))
vi.mock('@/features/computer/ComputerLinks', () => ({ ComputerLinks: () => null }))

const { ComputerTab } = await import('../ComputerTab')

describe('ComputerTab', () => {
  it('opens on the screen while the agent has a browser open', async () => {
    status.body = { ok: true, display: { running: false }, browserOpen: true }
    render(<ComputerTab agentId="a1" />)
    expect(await screen.findByText('screen view')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(screen.getByText('files view')).toBeTruthy()
  })

  it('offers to install the desktop tools where agents get no screen yet', async () => {
    status.body = {
      ok: true,
      display: { running: false },
      browserOpen: true,
      displays: { available: false, code: 'no-xvnc', reason: 'No Xvnc', installable: true },
    }
    render(<ComputerTab agentId="a3" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install the desktop tools' }))
    await vi.waitFor(() => expect(posted).toContain('/api/computer/tools/install'))
    expect(screen.getByTestId('desktop-tools-notice').textContent).toMatch(/GPL-2\.0/)
  })

  it('stays on the screen after an install, though nothing runs on it yet', async () => {
    status.body = {
      ok: true,
      display: { running: false },
      browserOpen: false,
      displays: { available: false, code: 'no-xvnc', reason: 'No Xvnc', installable: true },
    }
    render(<ComputerTab agentId="a7" />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Screen' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install the desktop tools' }))
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0))
    // The status is asked for again; the view the person chose stays.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByRole('tab', { name: 'Screen' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText('files view')).toBeNull()
  })

  it('offers no install that would not help: it says what to do instead, or nothing', async () => {
    status.body = {
      ok: true,
      display: { running: false },
      browserOpen: true,
      displays: {
        available: false,
        code: 'no-xvnc',
        reason: "Install TigerVNC's Xvnc with your package manager to give each agent one.",
        installable: false,
      },
    }
    const { unmount } = render(<ComputerTab agentId="a4" />)
    expect((await screen.findByTestId('desktop-tools-notice')).textContent).toMatch(
      /package manager/,
    )
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull()
    unmount()

    status.body = {
      ok: true,
      display: { running: false },
      browserOpen: true,
      displays: { available: false, code: 'off', reason: 'turned off', installable: false },
    }
    render(<ComputerTab agentId="a5" />)
    await screen.findByText('screen view')
    expect(screen.queryByTestId('desktop-tools-notice')).toBeNull()
  })

  it('offers Cua Driver alone where displays already work', async () => {
    status.body = {
      ok: true,
      display: { running: true },
      displays: { available: true, problem: null, driverInstallable: true },
    }
    render(<ComputerTab agentId="a6" />)
    expect(await screen.findByRole('button', { name: 'Install Cua Driver' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install the desktop tools' })).toBeNull()
  })

  it('opens on the files while nothing runs, and shows the screen on request', async () => {
    status.body = { ok: true, display: { running: false }, browserOpen: false }
    render(<ComputerTab agentId="a2" />)
    expect(await screen.findByText('files view')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Screen' }))
    expect(screen.getByText('screen view')).toBeTruthy()
  })
})
