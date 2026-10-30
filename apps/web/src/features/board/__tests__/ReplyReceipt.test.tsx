// Where a reply went, said under it: sent to the run, the agent starting on it,
// waiting for the next run, or not sent. A reply on a finished task offers to
// go to the same agent as a follow-up task, filed under the finished one.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReplyDelivery } from '@/lib/boardClient'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import { server } from '../../../__vitest__/mswServer'
import { ReplyReceipt, receiptText } from '../ReplyReceipt'

afterEach(() => cleanup())
beforeEach(() => {
  useFleetStore.setState({
    agents: [{ id: 'ada', name: 'Ada', teamId: 'team-1' } as AgentState],
    selectedAgentId: null,
  })
})

const TASK = { id: 't1', title: 'Write the launch post', teamId: 'team-1' }

describe('receiptText', () => {
  it.each<[ReplyDelivery, string]>([
    [{ status: 'steered', agentId: 'ada' }, 'Sent to Ada’s run'],
    [{ status: 'woke-agent', agentId: 'ada' }, 'Ada is starting on this'],
    [{ status: 'queued', agentId: 'ada', reason: 'next-run' }, 'Ada will see this on the next run'],
    [
      { status: 'queued', agentId: 'ada', reason: 'in-review' },
      'Ada will see this after the check',
    ],
    [
      { status: 'queued', agentId: 'ada', reason: 'waiting' },
      'Ada will see this when the task it waits on is done',
    ],
    [
      { status: 'not-delivered', agentId: 'ada', reason: 'finished' },
      'Not sent: the task is finished',
    ],
    [
      { status: 'not-delivered', agentId: null, reason: 'unassigned' },
      'Not sent: no agent has this task',
    ],
    [
      { status: 'not-delivered', agentId: 'ada', reason: 'failed' },
      'Not sent: something went wrong',
    ],
  ])('%j reads "%s"', (delivery, text) => {
    expect(receiptText(delivery, 'Ada')).toBe(text)
  })
})

describe('ReplyReceipt', () => {
  it('names the agent from the fleet', () => {
    render(
      <ReplyReceipt delivery={{ status: 'woke-agent', agentId: 'ada' }} task={TASK} body="x" />,
    )
    expect(screen.getByTestId('reply-receipt')).toHaveTextContent('Ada is starting on this')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('sends a reply on a finished task as a follow-up for the same agent, under the task', async () => {
    let made: Record<string, unknown> | null = null
    server.use(
      http.post('/api/board', async ({ request }) => {
        made = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ task: { id: 't2', title: 'Follow up', status: 'todo' } })
      }),
    )
    const onFollowUp = vi.fn()
    const user = userEvent.setup()
    render(
      <ReplyReceipt
        delivery={{ status: 'not-delivered', agentId: 'ada', reason: 'finished' }}
        task={TASK}
        body="Add the annual price too."
        onFollowUp={onFollowUp}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Send as a follow-up task' }))
    expect(await screen.findByText('Sent as a follow-up task for Ada')).toBeInTheDocument()
    expect(made).toEqual({
      title: 'Follow up: Write the launch post',
      description: 'Add the annual price too.',
      teamId: 'team-1',
      assigneeAgentId: 'ada',
      parentTaskId: 't1',
    })
    expect(onFollowUp).toHaveBeenCalledWith('t2')
    expect(screen.queryByRole('button', { name: 'Send as a follow-up task' })).toBeNull()
  })

  it('offers no follow-up when nobody had the task', () => {
    render(
      <ReplyReceipt
        delivery={{ status: 'not-delivered', agentId: null, reason: 'unassigned' }}
        task={TASK}
        body="x"
      />,
    )
    expect(screen.queryByRole('button', { name: 'Send as a follow-up task' })).toBeNull()
  })
})
