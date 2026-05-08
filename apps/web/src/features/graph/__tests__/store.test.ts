import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGraphStore } from '../store'
import type { GraphNode } from '../types'

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
      showTeamHalos: false,
      expandedBooNodeIds: new Set(),
      hoveredNodeId: null,
      highlightedNodeIds: null,
      highlightedEdgeIds: null,
      _physicsWakeCallback: null,
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

  describe('showTeamHalos', () => {
    it('defaults to false', () => {
      expect(useGraphStore.getState().showTeamHalos).toBe(false)
    })

    it('setShowTeamHalos(true) enables', () => {
      useGraphStore.getState().setShowTeamHalos(true)
      expect(useGraphStore.getState().showTeamHalos).toBe(true)
    })

    it('setShowTeamHalos(false) disables', () => {
      useGraphStore.getState().setShowTeamHalos(true)
      useGraphStore.getState().setShowTeamHalos(false)
      expect(useGraphStore.getState().showTeamHalos).toBe(false)
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

  describe('physics wake callback', () => {
    it('defaults to null', () => {
      expect(useGraphStore.getState()._physicsWakeCallback).toBeNull()
    })

    it('can be set and cleared', () => {
      const cb = vi.fn()
      useGraphStore.getState().setPhysicsWakeCallback(cb)
      expect(useGraphStore.getState()._physicsWakeCallback).toBe(cb)
      useGraphStore.getState().setPhysicsWakeCallback(null)
      expect(useGraphStore.getState()._physicsWakeCallback).toBeNull()
    })

    it('onNodesChange calls callback when boo position changes', () => {
      const cb = vi.fn()
      useGraphStore.setState({
        _physicsWakeCallback: cb,
        nodes: [
          {
            id: 'boo-a1',
            type: 'boo',
            position: { x: 0, y: 0 },
            data: { agentId: 'a1', name: 'A1', status: 'idle', model: null, isStreaming: false },
          },
        ] as GraphNode[],
      })
      useGraphStore
        .getState()
        .onNodesChange([{ type: 'position', id: 'boo-a1', position: { x: 50, y: 50 } }])
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('onNodesChange does NOT call callback for skill position changes', () => {
      const cb = vi.fn()
      useGraphStore.setState({
        _physicsWakeCallback: cb,
        nodes: [
          {
            id: 'skill-a1-bash',
            type: 'skill',
            position: { x: 100, y: 100 },
            data: {
              skillId: 'bash',
              name: 'bash',
              category: 'code',
              description: null,
              agentIds: ['a1'],
            },
          },
        ] as GraphNode[],
      })
      useGraphStore
        .getState()
        .onNodesChange([{ type: 'position', id: 'skill-a1-bash', position: { x: 150, y: 150 } }])
      expect(cb).not.toHaveBeenCalled()
    })

    it('onNodesChange does NOT call callback when no callback is set', () => {
      useGraphStore.setState({
        _physicsWakeCallback: null,
        nodes: [
          {
            id: 'boo-a1',
            type: 'boo',
            position: { x: 0, y: 0 },
            data: { agentId: 'a1', name: 'A1', status: 'idle', model: null, isStreaming: false },
          },
        ] as GraphNode[],
      })
      // Should not throw
      useGraphStore
        .getState()
        .onNodesChange([{ type: 'position', id: 'boo-a1', position: { x: 50, y: 50 } }])
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

  // ── expandedBooNodeIds — Boo orbital children visibility toggle ─────────
  // The Ghost Graph hides skill/resource nodes by default and reveals them
  // only when their parent Boo is in this Set (single-click toggle). Lets
  // the canvas at rest focus on team topology (Boos + dependency edges).
  describe('expandedBooNodeIds', () => {
    it('defaults to an empty Set', () => {
      expect(useGraphStore.getState().expandedBooNodeIds.size).toBe(0)
    })

    it('toggleBooNodeExpanded adds an ID when absent', () => {
      useGraphStore.getState().toggleBooNodeExpanded('boo-a1')
      expect(useGraphStore.getState().expandedBooNodeIds.has('boo-a1')).toBe(true)
    })

    it('toggleBooNodeExpanded removes an ID when present', () => {
      useGraphStore.getState().toggleBooNodeExpanded('boo-a1')
      useGraphStore.getState().toggleBooNodeExpanded('boo-a1')
      expect(useGraphStore.getState().expandedBooNodeIds.has('boo-a1')).toBe(false)
    })

    it('supports multiple Boos expanded simultaneously', () => {
      useGraphStore.getState().toggleBooNodeExpanded('boo-a1')
      useGraphStore.getState().toggleBooNodeExpanded('boo-a2')
      useGraphStore.getState().toggleBooNodeExpanded('boo-a3')
      const ids = useGraphStore.getState().expandedBooNodeIds
      expect(ids.size).toBe(3)
      expect(ids.has('boo-a1')).toBe(true)
      expect(ids.has('boo-a2')).toBe(true)
      expect(ids.has('boo-a3')).toBe(true)
    })

    it('setExpandedBooNodeIds replaces the entire Set', () => {
      useGraphStore.getState().toggleBooNodeExpanded('boo-a1')
      useGraphStore.getState().setExpandedBooNodeIds(new Set(['boo-x', 'boo-y']))
      const ids = useGraphStore.getState().expandedBooNodeIds
      expect(ids.has('boo-a1')).toBe(false)
      expect(ids.has('boo-x')).toBe(true)
      expect(ids.has('boo-y')).toBe(true)
    })

    it('collapseAllBooNodes empties the Set', () => {
      useGraphStore.getState().toggleBooNodeExpanded('boo-a1')
      useGraphStore.getState().toggleBooNodeExpanded('boo-a2')
      useGraphStore.getState().collapseAllBooNodes()
      expect(useGraphStore.getState().expandedBooNodeIds.size).toBe(0)
    })
  })
})
