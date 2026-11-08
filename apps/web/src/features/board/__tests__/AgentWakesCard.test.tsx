// The card that asks whether agents may wake each other on a job, and lifts a pause.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ANNOUNCED_REASONS } from '@/features/alerts/alertRules'
import { TeamAgentWakesToggle } from '@/features/group-chat/TeamAgentWakesToggle'
import { PERSON_CHECK_REFUSED, resetPersonCheckNotices } from '@/lib/personCheckNotice'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'

import { AgentWakesCard } from '../AgentWakesCard'
import { ATTENTION_META, attentionLabel, taskAttentionOf } from '../boardStatus'
import { pendingWakeText } from '../pendingWake'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const CARD = { jobTaskId: 'job1', kind: 'ask', fromAgentId: 'a1', toAgentId: 'a2' } as const

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
  resetPersonCheckNotices()
  useFleetStore.setState({
    agents: [
      { id: 'a1', name: 'Ada' },
      { id: 'a2', name: 'Bea' },
    ] as never,
  })
})

function pressed() {
  const calls: unknown[] = []
  server.use(
    http.post('/api/board/agent-wakes/job1', async ({ request }) => {
      calls.push(await request.json())
      return HttpResponse.json({ ok: true })
    }),
  )
  return calls
}

describe('AgentWakesCard', () => {
  it('says who wants to wake whom, and offers the three answers', async () => {
    const calls = pressed()
    const done = vi.fn()
    render(<AgentWakesCard card={CARD} teamId="T" onDecided={done} />)
    expect(screen.getByText(/Ada wants to wake Bea/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Allow on this job' }))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(calls).toEqual([{ decision: 'job' }])
  })

  it('always in this team, and no, send their own word', async () => {
    const calls = pressed()
    const { unmount } = render(<AgentWakesCard card={CARD} teamId="T" onDecided={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Always allow in this team' }))
    unmount()
    render(<AgentWakesCard card={CARD} teamId="T" onDecided={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'No' }))
    await waitFor(() => expect(calls).toEqual([{ decision: 'team' }, { decision: 'no' }]))
  })

  it('says when the answer also covers other tasks waiting on it', () => {
    render(<AgentWakesCard card={{ ...CARD, alsoWaiting: 2 }} teamId="T" onDecided={() => {}} />)
    expect(screen.getByText(/2 other tasks are waiting on this answer/)).toBeInTheDocument()
  })

  it('and for one, in the singular', () => {
    render(<AgentWakesCard card={{ ...CARD, alsoWaiting: 1 }} teamId="T" onDecided={() => {}} />)
    expect(screen.getByText(/1 other task is waiting on this answer/)).toBeInTheDocument()
  })

  it('a task with no team is not offered the team’s setting', () => {
    render(<AgentWakesCard card={CARD} teamId={null} onDecided={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Always allow in this team' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow on this job' })).toBeInTheDocument()
  })

  it('a pause at the hourly cap says so, and offers to lift it or end it', async () => {
    const calls = pressed()
    render(
      <AgentWakesCard card={{ ...CARD, kind: 'hourly_cap' }} teamId="T" onDecided={() => {}} />,
    )
    expect(screen.getByText(/12 times/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Always allow in this team' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Let them carry on' }))
    await waitFor(() => expect(calls).toEqual([{ decision: 'job' }]))
  })

  it('a back-and-forth names the two agents, and can be ended for the job', async () => {
    const calls = pressed()
    render(
      <AgentWakesCard card={{ ...CARD, kind: 'back_and_forth' }} teamId="T" onDecided={() => {}} />,
    )
    expect(screen.getByText(/Ada and Bea keep waking each other/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'No more on this job' }))
    await waitFor(() => expect(calls).toEqual([{ decision: 'no' }]))
  })

  it('an agent no one knows reads as a teammate', () => {
    useFleetStore.setState({ agents: [] as never })
    render(<AgentWakesCard card={CARD} teamId="T" onDecided={() => {}} />)
    expect(screen.getByText(/A teammate wants to wake a teammate/)).toBeInTheDocument()
  })

  it('a card that closed says so, and refreshes', async () => {
    server.use(
      http.post('/api/board/agent-wakes/job1', () =>
        HttpResponse.json({ ok: false, error: 'no_card' }, { status: 409 }),
      ),
    )
    const done = vi.fn()
    render(<AgentWakesCard card={CARD} teamId="T" onDecided={done} />)
    await userEvent.click(screen.getByRole('button', { name: 'No' }))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/already been answered/)
  })

  it('a refusal from the person check says why, once, and not to try again', async () => {
    server.use(
      http.post('/api/board/agent-wakes/job1', () =>
        HttpResponse.json({ ok: false, error: 'person_only' }, { status: 403 }),
      ),
    )
    const done = vi.fn()
    render(<AgentWakesCard card={CARD} teamId="T" onDecided={done} />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow on this job' }))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(PERSON_CHECK_REFUSED),
    )
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('the team’s setting', () => {
  it('reads what the server says, and a press saves it', async () => {
    const puts: unknown[] = []
    server.use(
      http.get('/api/team-agent-wakes/T', () => HttpResponse.json({ always: false })),
      http.put('/api/team-agent-wakes/T', async ({ request }) => {
        const body = (await request.json()) as { always: boolean }
        puts.push(body)
        return HttpResponse.json(body)
      }),
    )
    render(<TeamAgentWakesToggle teamId="T" />)
    const toggle = await screen.findByRole('switch')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(puts).toEqual([{ always: true }])
  })

  it('a save that failed says so, and shows what is still true', async () => {
    server.use(
      http.get('/api/team-agent-wakes/T', () => HttpResponse.json({ always: true })),
      http.put('/api/team-agent-wakes/T', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    render(<TeamAgentWakesToggle teamId="T" />)
    const toggle = await screen.findByRole('switch')
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(toggle)
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/try again/),
    )
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('a refusal from the person check says why, once, and not to try again', async () => {
    server.use(
      http.get('/api/team-agent-wakes/T', () => HttpResponse.json({ always: true })),
      http.put('/api/team-agent-wakes/T', () =>
        HttpResponse.json({ ok: false, error: 'person_only' }, { status: 403 }),
      ),
    )
    render(<TeamAgentWakesToggle teamId="T" />)
    const toggle = await screen.findByRole('switch')
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(toggle)
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(PERSON_CHECK_REFUSED),
    )
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })
})

describe('the team setting that could not be read', () => {
  it('says so and offers a retry, rather than reading as off', async () => {
    let reads = 0
    server.use(
      http.get('/api/team-agent-wakes/T', () => {
        reads += 1
        return reads === 1
          ? HttpResponse.json({ error: 'boom' }, { status: 500 })
          : HttpResponse.json({ always: true })
      }),
    )
    render(<TeamAgentWakesToggle teamId="T" />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t read this setting.')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const toggle = screen.getByRole('switch')
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(toggle).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a task that also failed its check', () => {
  it('says so on the card, and only then', () => {
    const { rerender } = render(
      <AgentWakesCard card={CARD} teamId="T" checkFailed onDecided={() => {}} />,
    )
    expect(screen.getByTestId('agent-wakes-check-failed')).toBeInTheDocument()
    rerender(<AgentWakesCard card={CARD} teamId="T" onDecided={() => {}} />)
    expect(screen.queryByTestId('agent-wakes-check-failed')).toBeNull()
  })

  it('names the button the card actually shows', () => {
    const { rerender } = render(
      <AgentWakesCard card={CARD} teamId="T" checkFailed onDecided={() => {}} />,
    )
    expect(screen.getByTestId('agent-wakes-check-failed')).toHaveTextContent('Saying yes')
    for (const kind of ['hourly_cap', 'back_and_forth'] as const) {
      rerender(
        <AgentWakesCard card={{ ...CARD, kind }} teamId="T" checkFailed onDecided={() => {}} />,
      )
      const notice = screen.getByTestId('agent-wakes-check-failed')
      expect(notice).toHaveTextContent('Letting them carry on does not change that.')
      expect(notice).not.toHaveTextContent(/yes/i)
    }
  })

  it('keeps that from the server when it reads the attention', () => {
    const attention = { reason: 'agent_wakes', failedRuns: 0, agentWakes: CARD, checkFailed: true }
    expect(taskAttentionOf({ status: 'blocked', attention })?.checkFailed).toBe(true)
  })
})

describe('browser alerts', () => {
  it('announce the card: an agent’s doing, and a person has to answer', () => {
    expect(ANNOUNCED_REASONS).toContain('agent_wakes')
  })
})

describe('the words around it', () => {
  it('Needs you reads the new reason off a board row', () => {
    const attention = taskAttentionOf({
      id: 't',
      status: 'blocked',
      attention: { reason: 'agent_wakes', failedRuns: 0, agentWakes: CARD },
    } as never)
    expect(attention?.reason).toBe('agent_wakes')
    expect(attention?.agentWakes).toEqual(CARD)
    const covering = taskAttentionOf({
      status: 'blocked',
      attention: {
        reason: 'agent_wakes',
        failedRuns: 0,
        agentWakes: { ...CARD, alsoWaiting: 3 },
      },
    })
    expect(covering?.agentWakes?.alsoWaiting).toBe(3)
    expect(attentionLabel(attention!)).toBe(ATTENTION_META.agent_wakes.label)
  })

  it('a card it cannot read shows no buttons rather than wrong ones', () => {
    for (const agentWakes of [{ kind: 'ask' }, { ...CARD, kind: 'other' }, 'nope'])
      expect(
        taskAttentionOf({
          status: 'blocked',
          attention: { reason: 'agent_wakes', failedRuns: 0, agentWakes },
        })?.agentWakes,
      ).toBeUndefined()
  })

  it('the drawer’s wait line has words for each new reason', () => {
    const wake = { reason: 'agent_comment', comments: 1, held: false }
    expect(pendingWakeText({ ...wake, skipReason: 'ask_once' }, 'Bea')).toMatch(
      /Waiting for your OK/,
    )
    expect(pendingWakeText({ ...wake, skipReason: 'hourly_cap' }, 'Bea')).toMatch(/this hour/)
    expect(pendingWakeText({ ...wake, skipReason: 'back_and_forth' }, 'Bea')).toMatch(
      /keep waking each other/,
    )
  })
})
