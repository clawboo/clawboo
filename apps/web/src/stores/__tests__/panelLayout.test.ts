import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})

const { usePanelLayoutStore } = await import('../panelLayout')

beforeEach(() => {
  store.clear()
  usePanelLayoutStore.setState({ panes: {} })
})

describe('panelLayout store', () => {
  it('treats a pane nobody has toggled as open', () => {
    expect(usePanelLayoutStore.getState().panes['agent:graph'] ?? true).toBe(true)
  })

  it('toggles a pane and remembers it in localStorage', () => {
    usePanelLayoutStore.getState().togglePane('agent:files')
    expect(usePanelLayoutStore.getState().panes['agent:files']).toBe(false)
    expect(JSON.parse(store.get('clawboo.panes') ?? '{}')).toEqual({ 'agent:files': false })

    usePanelLayoutStore.getState().togglePane('agent:files')
    expect(usePanelLayoutStore.getState().panes['agent:files']).toBe(true)
  })

  it("starts the agent's tasks and browser closed", () => {
    usePanelLayoutStore.getState().togglePane('agent:tasks')
    usePanelLayoutStore.getState().togglePane('agent:browser')
    expect(usePanelLayoutStore.getState().panes['agent:tasks']).toBe(true)
    expect(usePanelLayoutStore.getState().panes['agent:browser']).toBe(true)
  })

  it('starts Activity closed, and opens it on the first toggle', () => {
    usePanelLayoutStore.getState().togglePane('team:activity')
    expect(usePanelLayoutStore.getState().panes['team:activity']).toBe(true)
    usePanelLayoutStore.getState().togglePane('agent:activity')
    expect(usePanelLayoutStore.getState().panes['agent:activity']).toBe(true)
  })

  it('keeps each view independent', () => {
    usePanelLayoutStore.getState().setPaneOpen('team:graph', false)
    expect(usePanelLayoutStore.getState().panes['agent:graph']).toBeUndefined()
  })
})
