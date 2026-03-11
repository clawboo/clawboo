import { describe, it, expect, beforeEach } from 'vitest'
import { useGraphStore } from '../store'

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useGraphStore', () => {
  beforeEach(() => {
    useGraphStore.setState({
      nodes: [],
      edges: [],
      agentFiles: new Map(),
      savedPositions: {},
      layoutKey: 0,
      hasRunLayout: false,
      selectedEdgeId: null,
      isLoadingFiles: false,
      filesError: null,
      refreshKey: 0,
      connectMode: false,
      hoveredNodeId: null,
      highlightedNodeIds: null,
      highlightedEdgeIds: null,
    })
  })

  describe('connectMode', () => {
    it('defaults to false', () => {
      expect(useGraphStore.getState().connectMode).toBe(false)
    })

    it('setConnectMode(true) enables', () => {
      useGraphStore.getState().setConnectMode(true)
      expect(useGraphStore.getState().connectMode).toBe(true)
    })

    it('setConnectMode(false) disables', () => {
      useGraphStore.getState().setConnectMode(true)
      useGraphStore.getState().setConnectMode(false)
      expect(useGraphStore.getState().connectMode).toBe(false)
    })
  })

  describe('triggerRefresh', () => {
    it('increments refreshKey', () => {
      expect(useGraphStore.getState().refreshKey).toBe(0)
      useGraphStore.getState().triggerRefresh()
      expect(useGraphStore.getState().refreshKey).toBe(1)
    })

    it('increments on each call', () => {
      useGraphStore.getState().triggerRefresh()
      useGraphStore.getState().triggerRefresh()
      useGraphStore.getState().triggerRefresh()
      expect(useGraphStore.getState().refreshKey).toBe(3)
    })
  })

  describe('resetLayout', () => {
    it('clears savedPositions', () => {
      useGraphStore.getState().updateNodePosition('n1', { x: 10, y: 20 })
      expect(Object.keys(useGraphStore.getState().savedPositions).length).toBe(1)
      useGraphStore.getState().resetLayout()
      expect(useGraphStore.getState().savedPositions).toEqual({})
    })

    it('bumps layoutKey', () => {
      expect(useGraphStore.getState().layoutKey).toBe(0)
      useGraphStore.getState().resetLayout()
      expect(useGraphStore.getState().layoutKey).toBe(1)
    })

    it('resets hasRunLayout', () => {
      useGraphStore.getState().setHasRunLayout(true)
      useGraphStore.getState().resetLayout()
      expect(useGraphStore.getState().hasRunLayout).toBe(false)
    })
  })

  describe('selectedEdgeId', () => {
    it('defaults to null', () => {
      expect(useGraphStore.getState().selectedEdgeId).toBeNull()
    })

    it('sets edge id', () => {
      useGraphStore.getState().setSelectedEdgeId('e1')
      expect(useGraphStore.getState().selectedEdgeId).toBe('e1')
    })

    it('clears with null', () => {
      useGraphStore.getState().setSelectedEdgeId('e1')
      useGraphStore.getState().setSelectedEdgeId(null)
      expect(useGraphStore.getState().selectedEdgeId).toBeNull()
    })
  })

  describe('updateNodePosition', () => {
    it('saves position for a node', () => {
      useGraphStore.getState().updateNodePosition('n1', { x: 100, y: 200 })
      expect(useGraphStore.getState().savedPositions.n1).toEqual({ x: 100, y: 200 })
    })

    it('overwrites previous position', () => {
      useGraphStore.getState().updateNodePosition('n1', { x: 10, y: 20 })
      useGraphStore.getState().updateNodePosition('n1', { x: 30, y: 40 })
      expect(useGraphStore.getState().savedPositions.n1).toEqual({ x: 30, y: 40 })
    })

    it('preserves other nodes positions', () => {
      useGraphStore.getState().updateNodePosition('n1', { x: 10, y: 20 })
      useGraphStore.getState().updateNodePosition('n2', { x: 30, y: 40 })
      expect(useGraphStore.getState().savedPositions.n1).toEqual({ x: 10, y: 20 })
      expect(useGraphStore.getState().savedPositions.n2).toEqual({ x: 30, y: 40 })
    })
  })

  describe('hover cascade', () => {
    it('defaults to null', () => {
      const s = useGraphStore.getState()
      expect(s.hoveredNodeId).toBeNull()
      expect(s.highlightedNodeIds).toBeNull()
      expect(s.highlightedEdgeIds).toBeNull()
    })

    it('setHoveredNodeId(null) clears all hover state', () => {
      useGraphStore.getState().setHoveredNodeId('boo-a1')
      useGraphStore.getState().setHoveredNodeId(null)
      const s = useGraphStore.getState()
      expect(s.hoveredNodeId).toBeNull()
      expect(s.highlightedNodeIds).toBeNull()
      expect(s.highlightedEdgeIds).toBeNull()
    })

    it('populates connected sets from edges', () => {
      useGraphStore.setState({
        edges: [
          { id: 'e1', source: 'boo-a1', target: 'skill-a1-bash', type: 'skill', data: {} },
          { id: 'e2', source: 'boo-a1', target: 'boo-a2', type: 'dependency', data: {} },
          { id: 'e3', source: 'boo-a2', target: 'skill-a2-web', type: 'skill', data: {} },
        ],
      })

      useGraphStore.getState().setHoveredNodeId('boo-a1')
      const s = useGraphStore.getState()

      expect(s.hoveredNodeId).toBe('boo-a1')
      expect(s.highlightedNodeIds).toEqual(new Set(['boo-a1', 'skill-a1-bash', 'boo-a2']))
      expect(s.highlightedEdgeIds).toEqual(new Set(['e1', 'e2']))
    })

    it('hovering node with no edges highlights only itself', () => {
      useGraphStore.setState({
        edges: [{ id: 'e1', source: 'boo-a1', target: 'boo-a2', type: 'dependency', data: {} }],
      })

      useGraphStore.getState().setHoveredNodeId('boo-a3')
      const s = useGraphStore.getState()

      expect(s.highlightedNodeIds).toEqual(new Set(['boo-a3']))
      expect(s.highlightedEdgeIds).toEqual(new Set())
    })
  })

  describe('setAgentFiles', () => {
    it('sets files for an agent', () => {
      useGraphStore.getState().setAgentFiles('a1', { toolsMd: '## Tools', agentsMd: '## Agents' })
      const files = useGraphStore.getState().agentFiles.get('a1')
      expect(files).toEqual({ toolsMd: '## Tools', agentsMd: '## Agents' })
    })

    it('merges with existing files', () => {
      useGraphStore.getState().setAgentFiles('a1', { toolsMd: '## Tools' })
      useGraphStore.getState().setAgentFiles('a1', { agentsMd: '## Agents' })
      const files = useGraphStore.getState().agentFiles.get('a1')
      expect(files).toEqual({ toolsMd: '## Tools', agentsMd: '## Agents' })
    })

    it('does not affect other agents', () => {
      useGraphStore.getState().setAgentFiles('a1', { toolsMd: 'A1 tools' })
      useGraphStore.getState().setAgentFiles('a2', { toolsMd: 'A2 tools' })
      expect(useGraphStore.getState().agentFiles.get('a1')!.toolsMd).toBe('A1 tools')
      expect(useGraphStore.getState().agentFiles.get('a2')!.toolsMd).toBe('A2 tools')
    })
  })
})
