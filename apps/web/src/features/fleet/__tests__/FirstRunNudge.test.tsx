import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { FirstRunNudge } from '../FirstRunNudge'

afterEach(() => cleanup())

function settings(firstRunDismissedAt: number | null) {
  return http.get('/api/settings', () => HttpResponse.json({ firstRunDismissedAt }))
}
function board(doneCount: number) {
  return http.get('/api/board', () =>
    HttpResponse.json({ tasks: Array.from({ length: doneCount }, (_, i) => ({ id: `t${i}` })) }),
  )
}

beforeEach(() => {
  server.use(
    settings(null),
    board(0),
    http.post('/api/settings', () => HttpResponse.json({ ok: true })),
  )
})

describe('FirstRunNudge', () => {
  it('renders when not dismissed AND no completed tasks', async () => {
    render(<FirstRunNudge />)
    expect(await screen.findByTestId('first-run-nudge')).toBeInTheDocument()
    expect(screen.getByText(/your team is ready/i)).toBeInTheDocument()
  })

  it('does NOT render when already dismissed', async () => {
    server.use(settings(123456))
    render(<FirstRunNudge />)
    await expect(screen.findByTestId('first-run-nudge', {}, { timeout: 400 })).rejects.toThrow()
  })

  it('does NOT render when a task has completed', async () => {
    server.use(board(1))
    render(<FirstRunNudge />)
    await expect(screen.findByTestId('first-run-nudge', {}, { timeout: 400 })).rejects.toThrow()
  })

  it('dismiss persists firstRunDismissedAt and hides', async () => {
    const posted = vi.fn()
    server.use(
      http.post('/api/settings', async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json({ ok: true })
      }),
    )
    const user = userEvent.setup()
    render(<FirstRunNudge />)
    await user.click(await screen.findByTestId('first-run-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('first-run-nudge')).toBeNull())
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ firstRunDismissedAt: expect.any(Number) }),
    )
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<FirstRunNudge />)
    await screen.findByTestId('first-run-nudge')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
