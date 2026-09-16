// MemorySurface: modal branch = list + "Open full view" escape hatch;
// full-screen branch = Graph|List toggle persisted to localStorage.
// The RF canvas itself is not jsdom-rendered (repo precedent) — the graph view
// is mocked out and asserted by presence.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InSettingsModalContext } from '@/features/settings/settingsModalContext'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useViewStore } from '@/stores/view'
import { server } from '../../../__vitest__/mswServer'
import { useMemoryGraphStore } from '../graph/store'
import { MemorySurface } from '../MemorySurface'

vi.mock('../graph/MemoryGraphView', () => ({
  MemoryGraphView: () => <div data-testid="mock-memory-graph-view" />,
}))

function stubMemoryApi() {
  server.use(
    http.get('/api/memory/browse', () =>
      HttpResponse.json({ facts: [], procedures: [], learning: {} }),
    ),
    http.get('/api/memory/provider', () => HttpResponse.json({ provider: null })),
  )
}

beforeEach(() => {
  localStorage.clear()
  useMemoryGraphStore.getState().reset()
  useSettingsModalStore.setState({ open: false, view: 'memory', runtimeIntent: null })
  useViewStore.setState({ viewMode: { type: 'nav', view: 'graph' } })
  stubMemoryApi()
})
afterEach(() => cleanup())

describe('MemorySurface', () => {
  it('in the Settings modal: renders the list panel + Open full view (never the canvas)', async () => {
    useSettingsModalStore.setState({ open: true })
    render(
      <InSettingsModalContext.Provider value={true}>
        <MemorySurface />
      </InSettingsModalContext.Provider>,
    )
    expect(await screen.findByTestId('memory-panel')).toBeInTheDocument()
    expect(screen.getByTestId('memory-open-full')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-memory-graph-view')).not.toBeInTheDocument()
  })

  it('Open full view closes the modal and navigates to the memory view', async () => {
    useSettingsModalStore.setState({ open: true })
    const user = userEvent.setup()
    render(
      <InSettingsModalContext.Provider value={true}>
        <MemorySurface />
      </InSettingsModalContext.Provider>,
    )
    await user.click(await screen.findByTestId('memory-open-full'))
    expect(useSettingsModalStore.getState().open).toBe(false)
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'memory' })
  })

  it('full-screen: defaults to Graph mode and toggles to List (persisted)', async () => {
    const user = userEvent.setup()
    render(<MemorySurface />)
    expect(screen.getByTestId('mock-memory-graph-view')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /list/i }))
    expect(await screen.findByTestId('memory-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-memory-graph-view')).not.toBeInTheDocument()
    expect(localStorage.getItem('clawboo.memory.mode')).toBe('list')
  })

  it('honors a persisted list mode on mount', async () => {
    localStorage.setItem('clawboo.memory.mode', 'list')
    render(<MemorySurface />)
    expect(await screen.findByTestId('memory-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-memory-graph-view')).not.toBeInTheDocument()
  })
})
