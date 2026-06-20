import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installSkillForAgent } from '../installSkill'

// ── Mocks ────────────────────────────────────────────────────────────────────
// installSkillForAgent now routes through the unified capability pipeline
// (POST /api/capabilities/install via installCapability) — NOT a TOOLS.md write.

const { mockAddToast, mockTriggerRefresh, mockInstall } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockTriggerRefresh: vi.fn(),
  mockInstall: vi.fn(),
}))

vi.mock('@/lib/capabilitiesClient', () => ({
  installCapability: mockInstall,
}))

// No @/stores/fleet mock — installSkillForAgent no longer reads the agent (the
// fleet AgentState carries no runtime field); the server resolves runtime
// authoritatively, so the spec just sends the optimistic 'openclaw' default.

vi.mock('@/stores/toast', () => ({
  useToastStore: {
    getState: () => ({ addToast: mockAddToast }),
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
    mockInstall.mockResolvedValue({ ok: true })
  })

  it('installs via the capability pipeline with the right spec', async () => {
    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')
    expect(mockInstall).toHaveBeenCalledWith({
      via: 'native',
      agentId: 'agent-1',
      runtime: 'openclaw',
      kind: 'skill',
      name: 'new-skill',
    })
  })

  it('triggers a graph refresh + success toast on a successful install', async () => {
    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')
    expect(mockTriggerRefresh).toHaveBeenCalledOnce()
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: expect.stringContaining('new-skill') }),
    )
  })

  it('shows an error toast (and no refresh) when the install is rejected', async () => {
    mockInstall.mockResolvedValue({ ok: false, error: 'blocked' })
    await installSkillForAgent('new-skill', 'agent-1', 'Test Boo')
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('blocked') }),
    )
    expect(mockTriggerRefresh).not.toHaveBeenCalled()
  })
})
