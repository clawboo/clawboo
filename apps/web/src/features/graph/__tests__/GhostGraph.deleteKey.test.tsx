// Backspace must not delete an agent from the canvas.
//
// React Flow's default `deleteKeyCode` is 'Backspace', and its keyboard a11y
// binds Enter/Space to select a focused node — so Tab, Enter, Backspace removed
// an agent. That path goes through `onNodesChange` → `applyNodeChanges`, which
// only splices the node out of the local graph store: no confirmation, no
// `deleteAgentOperation`, no server call. The agent was untouched and reappeared
// on the next load.
//
// Only `<ReactFlow>` is stubbed, to capture its props; everything else in
// @xyflow/react stays real, so the surrounding hooks (`useReactFlow`,
// `useViewport`, …) work against a genuine ReactFlowProvider. Rendering the real
// canvas would drag in a layout engine and prove nothing extra — the guarantee
// lives entirely in the prop.

import { render, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'

const reactFlowProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('@xyflow/react', async (importActual) => ({
  ...(await importActual<typeof import('@xyflow/react')>()),
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps.current = props
    return <div data-testid="react-flow-stub" />
  },
}))

const { GhostGraph } = await import('../GhostGraph')

describe('GhostGraph — destructive key bindings', () => {
  beforeEach(() => {
    // The canvas fetches its saved layout and the observability overlay on mount.
    // Empty responses are enough — this asserts a prop, not rendered content.
    server.use(
      http.get('/api/graph-layout', () => HttpResponse.json({ positions: {} })),
      http.get('/api/obs/graph', () => HttpResponse.json({ nodes: [], edges: [] })),
      http.get('/api/obs/health', () => HttpResponse.json({ agents: [] })),
    )
  })

  it('disables React Flow’s Backspace-to-delete', async () => {
    render(
      <ReactFlowProvider>
        <GhostGraph scope="atlas" />
      </ReactFlowProvider>,
    )

    await waitFor(() => expect(reactFlowProps.current).not.toBeNull())

    // `null` disables it outright. Anything else — including leaving the prop
    // off, which is how this shipped — restores 'Backspace'.
    expect(reactFlowProps.current?.deleteKeyCode).toBeNull()
  })

  it('still allows selection, so the fix did not disable the canvas', () => {
    // Guards the lazy "fix": turning off `elementsSelectable` would also stop the
    // deletion, at the cost of the selection the hover cascade and the context
    // menu both rely on.
    expect(reactFlowProps.current?.elementsSelectable).toBe(true)
  })
})
