// The per-team switch: off at first, and a person's to change.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { TeamPlanApprovalSwitch } from '../TeamPlanApprovalSwitch'

afterEach(() => cleanup())

describe('TeamPlanApprovalSwitch', () => {
  it('reads as off at first, and says what it does and does not cover', async () => {
    server.use(http.get('/api/team-plan-approval/t1', () => HttpResponse.json({ on: false })))
    render(<TeamPlanApprovalSwitch teamId="t1" />)
    const toggle = await screen.findByRole('switch', { name: /ask me before splitting work/i })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    expect(screen.getByText(/one at a time still go straight\s+through/i)).toBeTruthy()
  })

  it('turns on, and stays on after the server agrees', async () => {
    const puts: unknown[] = []
    server.use(
      http.get('/api/team-plan-approval/t1', () => HttpResponse.json({ on: false })),
      http.put('/api/team-plan-approval/t1', async ({ request }) => {
        puts.push(await request.json())
        return HttpResponse.json({ on: true })
      }),
    )
    render(<TeamPlanApprovalSwitch teamId="t1" />)
    const toggle = await screen.findByRole('switch', { name: /ask me before splitting work/i })
    await waitFor(() => expect(toggle).not.toHaveProperty('disabled', true))
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(puts).toEqual([{ on: true }])
  })

  it('goes back when the save fails, and says so', async () => {
    useToastStore.setState({ toasts: [] })
    server.use(
      http.get('/api/team-plan-approval/t1', () => HttpResponse.json({ on: false })),
      http.put('/api/team-plan-approval/t1', () => HttpResponse.json({}, { status: 500 })),
    )
    render(<TeamPlanApprovalSwitch teamId="t1" />)
    const toggle = await screen.findByRole('switch', { name: /ask me before splitting work/i })
    await waitFor(() => expect(toggle).not.toHaveProperty('disabled', true))
    await userEvent.click(toggle)
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('a refusal from the person check says why, once, and not to try again', async () => {
    useToastStore.setState({ toasts: [] })
    server.use(
      http.get('/api/team-plan-approval/t1', () => HttpResponse.json({ on: false })),
      http.put('/api/team-plan-approval/t1', () =>
        HttpResponse.json({ ok: false, error: 'person_only' }, { status: 403 }),
      ),
    )
    render(<TeamPlanApprovalSwitch teamId="t1" />)
    const toggle = await screen.findByRole('switch', { name: /ask me before splitting work/i })
    await waitFor(() => expect(toggle).not.toHaveProperty('disabled', true))
    await userEvent.click(toggle)
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(PERSON_CHECK_REFUSED),
    )
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
})
