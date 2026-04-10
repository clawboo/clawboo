import { describe, it, expect, beforeEach } from 'vitest'
import { useViewStore } from '../view'
import type { NavView } from '../view'

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useViewStore', () => {
  beforeEach(() => {
    useViewStore.setState({ viewMode: { type: 'nav', view: 'graph' } })
  })

  it('starts with nav/graph as default view', () => {
    const { viewMode } = useViewStore.getState()
    expect(viewMode).toEqual({ type: 'nav', view: 'graph' })
  })

  // ── setViewMode ──────────────────────────────────────────────────────────

  describe('setViewMode', () => {
    it('sets an agent view', () => {
      useViewStore.getState().setViewMode({ type: 'agent', agentId: 'a1' })
      expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'a1' })
    })

    it('sets a nav view', () => {
      useViewStore.getState().setViewMode({ type: 'nav', view: 'cost' })
      expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'cost' })
    })

    it('sets welcome view', () => {
      useViewStore.getState().setViewMode({ type: 'welcome' })
      expect(useViewStore.getState().viewMode).toEqual({ type: 'welcome' })
    })

    it('sets booZero view', () => {
      useViewStore.getState().setViewMode({ type: 'booZero' })
      expect(useViewStore.getState().viewMode).toEqual({ type: 'booZero' })
    })

    it('sets groupChat view', () => {
      useViewStore.getState().setViewMode({ type: 'groupChat', teamId: 't1' })
      expect(useViewStore.getState().viewMode).toEqual({ type: 'groupChat', teamId: 't1' })
    })
  })

  // ── navigateTo ───────────────────────────────────────────────────────────

  describe('navigateTo', () => {
    it('sets viewMode to nav with the given view', () => {
      useViewStore.getState().navigateTo('approvals')
      expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'approvals' })
    })

    it('works for all NavView values', () => {
      const views: NavView[] = ['graph', 'approvals', 'cost', 'marketplace', 'scheduler', 'system']
      for (const view of views) {
        useViewStore.getState().navigateTo(view)
        expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view })
      }
    })
  })

  // ── openAgent ────────────────────────────────────────────────────────────

  describe('openAgent', () => {
    it('sets viewMode to agent with agentId', () => {
      useViewStore.getState().openAgent('agent-42')
      expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'agent-42' })
    })

    it('replaces previous view mode', () => {
      useViewStore.getState().navigateTo('cost')
      useViewStore.getState().openAgent('a1')
      expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'a1' })
    })
  })

  // ── openBooZero ──────────────────────────────────────────────────────────

  describe('openBooZero', () => {
    it('sets viewMode to booZero', () => {
      useViewStore.getState().openBooZero()
      expect(useViewStore.getState().viewMode).toEqual({ type: 'booZero' })
    })
  })

  // ── openGroupChat ──────────────────────────────────────────────────────

  describe('openGroupChat', () => {
    it('sets viewMode to groupChat with teamId', () => {
      useViewStore.getState().openGroupChat('team-42')
      expect(useViewStore.getState().viewMode).toEqual({ type: 'groupChat', teamId: 'team-42' })
    })

    it('replaces previous view mode', () => {
      useViewStore.getState().navigateTo('cost')
      useViewStore.getState().openGroupChat('t1')
      expect(useViewStore.getState().viewMode).toEqual({ type: 'groupChat', teamId: 't1' })
    })
  })
})
