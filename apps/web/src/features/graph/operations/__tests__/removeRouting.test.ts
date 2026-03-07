import { describe, it, expect, vi, beforeEach } from 'vitest'
import { removeRouting } from '../removeRouting'

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAddToast, mockFilesRead, mockFilesSet, mockEnqueue, mockSetEdges, mockSetAgentFiles } =
  vi.hoisted(() => ({
    mockAddToast: vi.fn(),
    mockFilesRead: vi.fn(),
    mockFilesSet: vi.fn(),
    mockEnqueue: vi.fn(),
    mockSetEdges: vi.fn(),
    mockSetAgentFiles: vi.fn(),
  }))

const MOCK_EDGES = [
  { id: 'dep-src-tgt', type: 'dependency', source: 'boo-src', target: 'boo-tgt', data: {} },
  { id: 'skill-1', type: 'skill', source: 'boo-src', target: 'skill-x', data: {} },
]

vi.mock('@/stores/connection', () => ({
  useConnectionStore: {
    getState: () => ({
      client: {
        agents: {
          files: { read: mockFilesRead, set: mockFilesSet },
        },
      },
    }),
  },
}))

vi.mock('@/stores/fleet', () => ({
  useFleetStore: {
    getState: () => ({
      agents: [
        { id: 'src', name: 'Source Boo' },
        { id: 'tgt', name: 'Target Boo' },
        { id: 'special', name: 'Foo (Bar)' },
      ],
    }),
  },
}))

vi.mock('@/stores/toast', () => ({
  useToastStore: {
    getState: () => ({ addToast: mockAddToast }),
  },
}))

vi.mock('@/lib/mutationQueue', () => ({
  mutationQueue: {
    enqueue: mockEnqueue,
  },
}))

vi.mock('../../store', () => ({
  useGraphStore: {
    getState: () => ({
      edges: MOCK_EDGES,
      setEdges: mockSetEdges,
      setAgentFiles: mockSetAgentFiles,
    }),
  },
}))

// ── Tests ────────────────────────────────────────────────────────────────────

describe('removeRouting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFilesRead.mockResolvedValue(
      '# AGENTS\n- Route to @Target Boo for delegated tasks.\n- Some other line\n',
    )
    mockEnqueue.mockImplementation((_id: string, fn: () => Promise<void>) => fn())
  })

  it('removes routing line from AGENTS.md', async () => {
    await removeRouting('dep-src-tgt', 'src', 'tgt')

    expect(mockFilesSet).toHaveBeenCalledWith('src', 'AGENTS.md', '# AGENTS\n- Some other line\n')
  })

  it('optimistically removes edge from graph', async () => {
    await removeRouting('dep-src-tgt', 'src', 'tgt')

    // First call is the optimistic removal
    expect(mockSetEdges).toHaveBeenCalledWith(MOCK_EDGES.filter((e) => e.id !== 'dep-src-tgt'))
  })

  it('updates agentFiles cache', async () => {
    await removeRouting('dep-src-tgt', 'src', 'tgt')

    expect(mockSetAgentFiles).toHaveBeenCalledWith('src', {
      agentsMd: '# AGENTS\n- Some other line\n',
    })
  })

  it('shows success toast', async () => {
    await removeRouting('dep-src-tgt', 'src', 'tgt')

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: expect.stringContaining('Source Boo') }),
    )
  })

  it('rolls back edges on write failure', async () => {
    mockEnqueue.mockRejectedValue(new Error('Write failed'))

    await removeRouting('dep-src-tgt', 'src', 'tgt')

    // Second setEdges call restores original edges
    expect(mockSetEdges).toHaveBeenCalledTimes(2)
    expect(mockSetEdges).toHaveBeenLastCalledWith(MOCK_EDGES)
  })

  it('shows error toast on failure', async () => {
    mockEnqueue.mockRejectedValue(new Error('Write failed'))

    await removeRouting('dep-src-tgt', 'src', 'tgt')

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed to remove routing' }),
    )
  })

  it('handles missing AGENTS.md gracefully', async () => {
    mockFilesRead.mockRejectedValue(new Error('Not found'))

    await removeRouting('dep-src-tgt', 'src', 'tgt')

    expect(mockFilesSet).not.toHaveBeenCalled()
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
  })

  it('returns early if target agent not found', async () => {
    await removeRouting('dep-src-tgt', 'src', 'nonexistent')

    expect(mockSetEdges).not.toHaveBeenCalled()
    expect(mockFilesRead).not.toHaveBeenCalled()
  })

  it('returns early if source agent not found', async () => {
    await removeRouting('dep-src-tgt', 'nonexistent', 'tgt')

    expect(mockSetEdges).not.toHaveBeenCalled()
    expect(mockFilesRead).not.toHaveBeenCalled()
  })

  it('does nothing without client', async () => {
    const { useConnectionStore } = await import('@/stores/connection')
    vi.spyOn(useConnectionStore, 'getState').mockReturnValueOnce({ client: null } as never)

    await removeRouting('dep-src-tgt', 'src', 'tgt')

    expect(mockSetEdges).not.toHaveBeenCalled()
  })

  it('handles special characters in agent name', async () => {
    mockFilesRead.mockResolvedValue(
      '# AGENTS\n- Route to @Foo (Bar) for tasks.\n- Keep this line\n',
    )

    await removeRouting('dep-src-special', 'src', 'special')

    expect(mockFilesSet).toHaveBeenCalledWith('src', 'AGENTS.md', '# AGENTS\n- Keep this line\n')
  })
})
