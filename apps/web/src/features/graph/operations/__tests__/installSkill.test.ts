import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installSkillForAgent } from '../installSkill'

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAddToast, mockTriggerRefresh, mockFilesRead, mockFilesSet, mockEnqueue } = vi.hoisted(
  () => ({
    mockAddToast: vi.fn(),
    mockTriggerRefresh: vi.fn(),
    mockFilesRead: vi.fn(),
    mockFilesSet: vi.fn(),
    mockEnqueue: vi.fn(),
  }),
)

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
    getState: () => ({ triggerRefresh: mockTriggerRefresh }),
  },
}))

// ── Tests ────────────────────────────────────────────────────────────────────

describe('installSkillForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFilesRead.mockResolvedValue('## Skills\n- existing-skill\n')
    mockEnqueue.mockImplementation((_id: string, fn: () => Promise<void>) => fn())
  })

  it('appends skill to TOOLS.md', async () => {
    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')

    expect(mockEnqueue).toHaveBeenCalledWith('agent-1', expect.any(Function))
    expect(mockFilesSet).toHaveBeenCalledWith(
      'agent-1',
      'TOOLS.md',
      '## Skills\n- existing-skill\n- new-skill\n',
    )
  })

  it('shows info toast if skill already exists', async () => {
    mockFilesRead.mockResolvedValue('## Skills\n- new-skill\n')

    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')

    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }))
    expect(mockFilesSet).not.toHaveBeenCalled()
  })

  it('handles empty TOOLS.md', async () => {
    mockFilesRead.mockResolvedValue('')

    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')

    expect(mockFilesSet).toHaveBeenCalledWith('agent-1', 'TOOLS.md', '\n- new-skill\n')
  })

  it('calls triggerRefresh after install', async () => {
    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')

    expect(mockTriggerRefresh).toHaveBeenCalledOnce()
  })

  it('shows success toast on install', async () => {
    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: expect.stringContaining('new-skill') }),
    )
  })

  it('shows error toast on failure', async () => {
    mockFilesRead.mockRejectedValue(new Error('Network error'))

    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('Network error') }),
    )
  })

  it('does nothing without client', async () => {
    const { useConnectionStore } = await import('@/stores/connection')
    vi.spyOn(useConnectionStore, 'getState').mockReturnValueOnce({ client: null } as never)

    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')

    expect(mockFilesRead).not.toHaveBeenCalled()
    expect(mockFilesSet).not.toHaveBeenCalled()
  })

  it('uses mutationQueue for serialized write', async () => {
    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')

    expect(mockEnqueue).toHaveBeenCalledWith('agent-1', expect.any(Function))
  })
})
