// The card on a job that has started as many runs by itself as it may.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ANNOUNCED_REASONS, ALERT_TRIGGER_KINDS } from '@/features/alerts/alertRules'
import { PERSON_CHECK_REFUSED, resetPersonCheckNotices } from '@/lib/personCheckNotice'
import { useToastStore } from '@/stores/toast'

import { ATTENTION_META, taskAttentionOf, waitingWorkLabel } from '../boardStatus'
import { JobLimitCard } from '../JobLimitCard'
import { pendingWakeText } from '../pendingWake'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const CARD = { jobTaskId: 'job1', runs: 100, limit: 100 }

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
  resetPersonCheckNotices()
})

function pressed(reply: Record<string, unknown> = { ok: true }, status = 200) {
  const calls: unknown[] = []
  server.use(
    http.post('/api/board/job-limit/job1', async ({ request }) => {
      calls.push(await request.json())
      return HttpResponse.json(reply, { status })
    }),
  )
  return calls
}

describe('JobLimitCard', () => {
  it('says how far the job got, and sends a person’s carry on', async () => {
    const calls = pressed()
    const onDecided = vi.fn()
    render(<JobLimitCard card={CARD} onDecided={onDecided} />)
    expect(screen.getByText('This job has started 100 runs by itself.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Carry on' }))
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(calls).toEqual([{ decision: 'carry_on' }])
  })

  it('sends a Stop', async () => {
    const calls = pressed()
    const onDecided = vi.fn()
    render(<JobLimitCard card={CARD} onDecided={onDecided} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(calls).toEqual([{ decision: 'stop' }])
  })

  it('says what each answer does, in plain words', () => {
    render(<JobLimitCard card={CARD} onDecided={vi.fn()} />)
    expect(screen.getByText(/Carry on lets it start another 100/)).toBeTruthy()
    expect(screen.getByText(/Stop ends the runs going under this job/)).toBeTruthy()
    expect(screen.getByText(/Other jobs keep going/)).toBeTruthy()
  })

  it('a card someone else answered goes away', async () => {
    pressed({ ok: false, error: 'no_card' }, 409)
    const onDecided = vi.fn()
    render(<JobLimitCard card={CARD} onDecided={onDecided} />)
    await userEvent.click(screen.getByRole('button', { name: 'Carry on' }))
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(useToastStore.getState().toasts[0]?.message).toBe('That has already been answered.')
  })

  it('a refusal for not being a person says so, and keeps the card', async () => {
    pressed({ ok: false, error: 'person_only' }, 403)
    const onDecided = vi.fn()
    render(<JobLimitCard card={CARD} onDecided={onDecided} />)
    await userEvent.click(screen.getByRole('button', { name: 'Carry on' }))
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toBe(PERSON_CHECK_REFUSED),
    )
    expect(onDecided).not.toHaveBeenCalled()
  })
})

describe('job_limit on every surface', () => {
  it('reads off a task’s attention, with its card, on any status', () => {
    const attention = { reason: 'job_limit', failedRuns: 0, jobLimit: CARD }
    expect(taskAttentionOf({ status: 'done', attention })).toMatchObject({
      reason: 'job_limit',
      jobLimit: CARD,
    })
    // A frame with a broken card still routes the task, with no controls to press.
    expect(
      taskAttentionOf({ status: 'done', attention: { ...attention, jobLimit: { runs: 'x' } } }),
    ).toEqual({ reason: 'job_limit', failedRuns: 0 })
  })

  it('has its label, its alert and its reason on a waiting wake', () => {
    expect(ATTENTION_META.job_limit.label).toBeTruthy()
    expect(ANNOUNCED_REASONS).toContain('job_limit')
    expect(ALERT_TRIGGER_KINDS.has('job_limit_reached')).toBe(true)
    expect(pendingWakeText({ comments: 1, skipReason: 'job_limit' } as never, 'Ada')).toMatch(
      /carry on/,
    )
    expect(pendingWakeText({ comments: 1, skipReason: 'job_stopped' } as never, 'Ada')).toMatch(
      /A person stopped this job/,
    )
  })

  it('a task behind a job a person stopped says so, once nothing else does', () => {
    const behind = { status: 'todo', jobStopped: true }
    expect(waitingWorkLabel(behind)).toMatch(/Stopped with its job/)
    expect(
      waitingWorkLabel({
        status: 'blocked',
        jobStopped: true,
        waitingOn: JSON.stringify({ kind: 'task', taskId: 'x' }),
      }),
    ).toMatch(/Stopped with its job/)
    // Needs you says it already, and a person's own wait is theirs to answer.
    expect(waitingWorkLabel({ ...behind, attention: { reason: 'stopped' } })).toBeNull()
    expect(
      waitingWorkLabel({
        status: 'blocked',
        jobStopped: true,
        waitingOn: JSON.stringify({ kind: 'person', need: 'A key', by: 'agent' }),
      }),
    ).toBeNull()
    expect(waitingWorkLabel({ status: 'todo' })).toBeNull()
  })
})
