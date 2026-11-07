// A chat's hand-off cards. This stream sends the whole row, unlike a team chat's board
// frames, so what a frame says about the assignee is what is true.

import { beforeEach, describe, expect, it } from 'vitest'

import { useChatHandOffStore } from '../chatHandOffs'

const frame = (over: Record<string, unknown>) =>
  ({ id: 't1', status: 'in_progress', updatedAt: 1_000, teamId: 'T', ...over }) as never

const card = () => useChatHandOffStore.getState().tasksByAgent.get('bz')?.get('t1')

beforeEach(() => {
  useChatHandOffStore.setState({ tasksByAgent: new Map(), handsOffByAgent: new Map() })
  useChatHandOffStore.getState().applyFrame('bz', frame({ assigneeAgentId: 'coder' }))
})

describe('a chat hand-off card', () => {
  it('names no agent once a frame says it has none: a hand-off back in To do', () => {
    useChatHandOffStore
      .getState()
      .applyFrame('bz', frame({ status: 'todo', assigneeAgentId: null, updatedAt: 2_000 }))
    expect(card()).toMatchObject({ status: 'todo', assigneeAgentId: null })
  })

  it('keeps the agent when a frame says nothing about it', () => {
    useChatHandOffStore.getState().applyFrame('bz', frame({ updatedAt: 2_000 }))
    expect(card()?.assigneeAgentId).toBe('coder')
  })

  it('an older frame takes nothing away', () => {
    useChatHandOffStore
      .getState()
      .applyFrame('bz', frame({ status: 'todo', assigneeAgentId: null, updatedAt: 500 }))
    expect(card()).toMatchObject({ status: 'in_progress', assigneeAgentId: 'coder' })
  })
})
