// @vitest-environment jsdom
// Browser storage belongs to the origin, so two instances served under different
// base paths on one origin (CLAWBOO_BASE_PATH behind a reverse proxy) used to read
// each other's keys. Each `asInstance` call below loads the real modules fresh as
// the instance at that base path, the way a page load would, against ONE shared
// localStorage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type BaseGlobal = { __CLAWBOO_BASE__?: string }

async function asInstance<T>(base: string | undefined, load: () => Promise<T>): Promise<T> {
  if (base === undefined) delete (globalThis as BaseGlobal).__CLAWBOO_BASE__
  else (globalThis as BaseGlobal).__CLAWBOO_BASE__ = base
  vi.resetModules()
  return load()
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  delete (globalThis as BaseGlobal).__CLAWBOO_BASE__
})

describe('two instances on one origin', () => {
  it('a fresh instance does not inherit the wizard or tour state of another', async () => {
    await asInstance('/a', async () => {
      const { markWizardActive } = await import('@/lib/onboardingProgress')
      const { markSeenFlag, CAPABILITY_TOUR_FLAG } = await import('@/lib/oneTimeFlag')
      markWizardActive()
      markSeenFlag(CAPABILITY_TOUR_FLAG)
    })
    await asInstance('/b', async () => {
      const { isWizardActive } = await import('@/lib/onboardingProgress')
      const { hasSeenFlag, CAPABILITY_TOUR_FLAG } = await import('@/lib/oneTimeFlag')
      expect(isWizardActive()).toBe(false)
      expect(hasSeenFlag(CAPABILITY_TOUR_FLAG)).toBe(false)
    })
    await asInstance('/a', async () => {
      const { isWizardActive } = await import('@/lib/onboardingProgress')
      const { hasSeenFlag, CAPABILITY_TOUR_FLAG } = await import('@/lib/oneTimeFlag')
      expect(isWizardActive()).toBe(true)
      expect(hasSeenFlag(CAPABILITY_TOUR_FLAG)).toBe(true)
    })
  })

  it('keeps the layout of each instance to itself', async () => {
    await asInstance('/a', async () => {
      const { usePanelLayoutStore, safeLayoutStorage } = await import('@/stores/panelLayout')
      const { useViewStore } = await import('@/stores/view')
      const { useGraphStore } = await import('@/features/graph/store')
      usePanelLayoutStore.getState().setPaneOpen('agent:files', false)
      useViewStore.getState().setSidebarWidth(300)
      useViewStore.getState().setColumnCollapsed(true)
      useGraphStore.getState().setAtlasLayout('top-down')
      safeLayoutStorage.setItem('react-resizable-panels:agent-detail-cards-h', '[60,40]')
    })
    await asInstance('/b', async () => {
      const { usePanelLayoutStore, safeLayoutStorage } = await import('@/stores/panelLayout')
      const { useViewStore, SIDEBAR_NATURAL_WIDTH } = await import('@/stores/view')
      const { useGraphStore } = await import('@/features/graph/store')
      expect(usePanelLayoutStore.getState().panes).toEqual({})
      expect(useViewStore.getState().sidebarWidth).toBe(SIDEBAR_NATURAL_WIDTH)
      expect(useViewStore.getState().columnCollapsed).toBe(false)
      expect(useGraphStore.getState().atlasLayout).toBe('radial')
      expect(safeLayoutStorage.getItem('react-resizable-panels:agent-detail-cards-h')).toBeNull()
    })
    await asInstance('/a', async () => {
      const { usePanelLayoutStore } = await import('@/stores/panelLayout')
      const { useViewStore } = await import('@/stores/view')
      expect(usePanelLayoutStore.getState().panes).toEqual({ 'agent:files': false })
      expect(useViewStore.getState().sidebarWidth).toBe(300)
    })
  })

  it("keeps one instance's board memory out of another", async () => {
    await asInstance('/a', async () => {
      const { rememberAssignee } = await import('@/features/board/newTaskMemory')
      rememberAssignee('team-1', 'agent-1')
    })
    await asInstance('/b', async () => {
      const { recentAssignees } = await import('@/features/board/newTaskMemory')
      expect(recentAssignees(null)).toEqual([])
    })
  })

  it('moves a key stored before the prefix into the first instance that reads it', async () => {
    localStorage.setItem('clawboo.tour.shown', '1')
    localStorage.setItem('clawboo:chat:session:v1', JSON.stringify({ a1: 'agent:a1:old' }))
    await asInstance('/a', async () => {
      const { hasSeenFlag, CAPABILITY_TOUR_FLAG } = await import('@/lib/oneTimeFlag')
      const { recallSession } = await import('@/features/chat/currentSession')
      expect(hasSeenFlag(CAPABILITY_TOUR_FLAG)).toBe(true)
      expect(recallSession('a1')).toBe('agent:a1:old')
    })
    expect(localStorage.getItem('clawboo.tour.shown')).toBeNull()
    expect(localStorage.getItem('/a:clawboo.tour.shown')).toBe('1')
    await asInstance('/b', async () => {
      const { hasSeenFlag, CAPABILITY_TOUR_FLAG } = await import('@/lib/oneTimeFlag')
      const { recallSession } = await import('@/features/chat/currentSession')
      expect(hasSeenFlag(CAPABILITY_TOUR_FLAG)).toBe(false)
      expect(recallSession('a1')).toBeNull()
    })
  })

  it('leaves the keys of an instance at the root spelled as before', async () => {
    await asInstance(undefined, async () => {
      const { markSeenFlag, CAPABILITY_TOUR_FLAG } = await import('@/lib/oneTimeFlag')
      const { rememberAssignee } = await import('@/features/board/newTaskMemory')
      markSeenFlag(CAPABILITY_TOUR_FLAG)
      rememberAssignee('team-1', 'agent-1')
    })
    expect(Object.keys(localStorage).sort()).toEqual([
      'clawboo.board.new-task-agents',
      'clawboo.tour.shown',
    ])
  })
})

describe('scoped storage', () => {
  it('spells a key with the base path in front, and leaves it alone at the root', async () => {
    await asInstance('/team/a', async () => {
      const { scopedStorageKey } = await import('@/lib/clientStorage')
      expect(scopedStorageKey('clawboo.theme')).toBe('/team/a:clawboo.theme')
    })
    await asInstance('/', async () => {
      const { scopedStorageKey } = await import('@/lib/clientStorage')
      expect(scopedStorageKey('clawboo.theme')).toBe('clawboo.theme')
    })
  })

  it('removes both spellings, so a removed key does not come back from before', async () => {
    localStorage.setItem('clawboo.onboarded', '1')
    await asInstance('/a', async () => {
      const { scopedLocalStorage } = await import('@/lib/clientStorage')
      scopedLocalStorage.removeItem('clawboo.onboarded')
      expect(scopedLocalStorage.getItem('clawboo.onboarded')).toBeNull()
    })
    expect(localStorage.getItem('clawboo.onboarded')).toBeNull()
  })

  it('lists its own keys and the unmoved old ones, never another instance', async () => {
    localStorage.setItem('clawboo.board.seen.old', '{}')
    localStorage.setItem('/b:clawboo.board.seen.theirs', '{}')
    localStorage.setItem('/a/b:clawboo.board.seen.nested', '{}')
    await asInstance('/a', async () => {
      const { scopedLocalStorage } = await import('@/lib/clientStorage')
      scopedLocalStorage.setItem('clawboo.board.seen.mine', '{}')
      expect(scopedLocalStorage.keys().sort()).toEqual([
        'clawboo.board.seen.mine',
        'clawboo.board.seen.old',
      ])
    })
    await asInstance(undefined, async () => {
      const { scopedLocalStorage } = await import('@/lib/clientStorage')
      expect(scopedLocalStorage.keys()).toEqual(['clawboo.board.seen.old'])
    })
  })

  it('scopes sessionStorage the same way', async () => {
    await asInstance('/a', async () => {
      const { scopedSessionStorage } = await import('@/lib/clientStorage')
      scopedSessionStorage.setItem('clawboo.board.earlierOpen', 'true')
    })
    expect(sessionStorage.getItem('/a:clawboo.board.earlierOpen')).toBe('true')
    await asInstance('/b', async () => {
      const { scopedSessionStorage } = await import('@/lib/clientStorage')
      expect(scopedSessionStorage.getItem('clawboo.board.earlierOpen')).toBeNull()
    })
  })

  it('never throws when storage does', async () => {
    const boom = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'key').mockImplementation(boom)
    await asInstance('/a', async () => {
      const { scopedLocalStorage } = await import('@/lib/clientStorage')
      expect(scopedLocalStorage.getItem('k')).toBeNull()
      expect(() => scopedLocalStorage.setItem('k', 'v')).not.toThrow()
      expect(() => scopedLocalStorage.removeItem('k')).not.toThrow()
      expect(scopedLocalStorage.keys()).toEqual([])
    })
  })

  it('still answers from an old key it could not move', async () => {
    localStorage.setItem('clawboo.memory.mode', 'list')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    await asInstance('/a', async () => {
      const { scopedLocalStorage } = await import('@/lib/clientStorage')
      expect(scopedLocalStorage.getItem('clawboo.memory.mode')).toBe('list')
    })
    vi.restoreAllMocks()
    expect(localStorage.getItem('clawboo.memory.mode')).toBe('list')
  })
})
