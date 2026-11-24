// The view store's own history, behind the slim top bar's back and forward: a
// move pushes the page it leaves, a step moves between the two stacks, a page
// that vanished is replaced rather than pushed, and the stacks stay bounded.

import { beforeEach, describe, expect, it } from 'vitest'

import { VIEW_HISTORY_LIMIT, sameView, useViewStore, type ViewMode } from '../view'

const view = () => useViewStore.getState()

beforeEach(() => {
  useViewStore.setState({
    viewMode: { type: 'nav', view: 'graph' },
    viewHistory: { past: [], future: [] },
    boardFocus: null,
    boardNeedsYouFocus: null,
    homeFocus: null,
  })
})

describe('moving between views', () => {
  it('pushes the page it leaves onto past, and every kind of move counts', () => {
    view().navigateTo('board')
    view().openAgent('a1')
    view().openHome('t1')
    view().openGroupChat('t1', 'r1')
    view().openBooZero()
    view().setViewMode({ type: 'welcome' })
    view().openBoardTask('task-1')
    expect(view().viewHistory.past).toEqual([
      { type: 'nav', view: 'graph' },
      { type: 'nav', view: 'board' },
      { type: 'agent', agentId: 'a1' },
      { type: 'nav', view: 'home' },
      { type: 'groupChat', teamId: 't1', roomId: 'r1' },
      { type: 'booZero' },
      { type: 'welcome' },
    ])
    expect(view().viewMode).toEqual({ type: 'nav', view: 'board' })
  })

  it('does not push the same page again, but still hands over a new view object', () => {
    view().navigateTo('board')
    const before = view().viewMode
    view().openBoardNeedsYou()
    expect(view().viewHistory.past).toEqual([{ type: 'nav', view: 'graph' }])
    // Whatever reacts to a navigation (the phone drawer closing) still sees one.
    expect(view().viewMode).not.toBe(before)
    expect(view().boardNeedsYouFocus).not.toBeNull()
  })

  it('keeps no more than the limit, dropping the oldest', () => {
    for (let i = 0; i < VIEW_HISTORY_LIMIT + 10; i++) view().openAgent(`a${i}`)
    const { past } = view().viewHistory
    expect(past).toHaveLength(VIEW_HISTORY_LIMIT)
    expect(past[past.length - 1]).toEqual({ type: 'agent', agentId: `a${VIEW_HISTORY_LIMIT + 8}` })
  })

  it('replaces a page that went away without leaving it in the history', () => {
    view().openGroupChat('t1')
    view().replaceViewMode({ type: 'welcome' })
    expect(view().viewMode).toEqual({ type: 'welcome' })
    expect(view().viewHistory.past).toEqual([{ type: 'nav', view: 'graph' }])
  })
})

describe('stepping back and forward', () => {
  it('goes back to the last page and forward again, and a new move clears forward', () => {
    view().navigateTo('board')
    view().openAgent('a1')

    expect(view().stepViewHistory('back')).toEqual({ type: 'nav', view: 'board' })
    expect(view().viewMode).toEqual({ type: 'nav', view: 'board' })
    expect(view().stepViewHistory('back')).toEqual({ type: 'nav', view: 'graph' })
    expect(view().viewHistory).toEqual({
      past: [],
      future: [
        { type: 'nav', view: 'board' },
        { type: 'agent', agentId: 'a1' },
      ],
    })

    expect(view().stepViewHistory('forward')).toEqual({ type: 'nav', view: 'board' })
    expect(view().viewHistory.past).toEqual([{ type: 'nav', view: 'graph' }])

    view().navigateTo('memory')
    expect(view().viewHistory.future).toEqual([])
  })

  it('answers null and changes nothing with nowhere to go', () => {
    const before = view().viewMode
    expect(view().stepViewHistory('back')).toBeNull()
    expect(view().stepViewHistory('forward')).toBeNull()
    expect(view().viewMode).toBe(before)
  })

  it('skips and drops the pages the caller says are gone', () => {
    view().openGroupChat('gone')
    view().openAgent('a1')
    view().openGroupChat('gone')
    view().navigateTo('board')

    const usable = (m: ViewMode) => !(m.type === 'groupChat' && m.teamId === 'gone')
    expect(view().stepViewHistory('back', usable)).toEqual({ type: 'agent', agentId: 'a1' })
    // The deleted team's page that was stepped over is gone from the history.
    expect(view().viewHistory.past).toEqual([
      { type: 'nav', view: 'graph' },
      { type: 'groupChat', teamId: 'gone' },
    ])
    expect(view().stepViewHistory('back', usable)).toEqual({ type: 'nav', view: 'graph' })
  })
})

describe('Home', () => {
  it('opens Home with a one-shot request for the team and goal', () => {
    view().openHome('t1', 'g1')
    expect(view().viewMode).toEqual({ type: 'nav', view: 'home' })
    expect(view().homeFocus).toMatchObject({ teamId: 't1', goalId: 'g1' })
    const first = view().homeFocus!.nonce
    // Asking again on Home is a new request, but not a new page in the history.
    view().openHome('t1', 'g1')
    expect(view().homeFocus!.nonce).toBe(first + 1)
    expect(view().viewHistory.past).toEqual([{ type: 'nav', view: 'graph' }])
    view().clearHomeFocus()
    expect(view().homeFocus).toBeNull()
  })

  it('keeps the request it has when opened with no team', () => {
    view().openHome()
    expect(view().viewMode).toEqual({ type: 'nav', view: 'home' })
    expect(view().homeFocus).toBeNull()
  })
})

describe('sameView', () => {
  it('tells pages apart by what they show, not by object', () => {
    expect(sameView({ type: 'nav', view: 'board' }, { type: 'nav', view: 'board' })).toBe(true)
    expect(sameView({ type: 'nav', view: 'board' }, { type: 'nav', view: 'inbox' })).toBe(false)
    expect(
      sameView(
        { type: 'groupChat', teamId: 't1' },
        { type: 'groupChat', teamId: 't1', roomId: null },
      ),
    ).toBe(true)
    expect(
      sameView(
        { type: 'groupChat', teamId: 't1' },
        { type: 'groupChat', teamId: 't1', roomId: 'r1' },
      ),
    ).toBe(false)
    expect(sameView({ type: 'agent', agentId: 'a1' }, { type: 'groupChat', teamId: 'a1' })).toBe(
      false,
    )
  })
})
