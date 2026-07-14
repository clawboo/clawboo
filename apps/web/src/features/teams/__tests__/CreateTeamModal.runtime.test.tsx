// CreateTeamModal — the PER-AGENT runtime selector + deploy wiring. Uses the RTL/msw
// pattern (onUnhandledRequest:'error'). `createAgent` is module-mocked so we assert
// the per-agent sourceId/execConfig the deploy loop builds + partial-failure. There is
// no team-level runtime toggle anymore: every agent (leader included) picks its runtime,
// defaulting to the catalog source rule (marketplace team → OpenClaw), degraded to
// Clawboo Native when the Gateway is offline.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useToastStore } from '@/stores/toast'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useSettingsModalStore } from '@/stores/settingsModal'
import type { GatewayClient } from '@clawboo/gateway-client'
import type { ProfileLike } from '../types'

const createAgentMock = vi.fn(
  async (
    name: string,
    _files?: unknown,
    _sourceId?: string,
    _execConfig?: unknown,
  ): Promise<string> => `id-${name}`,
)
vi.mock('@/lib/createAgent', () => ({
  createAgent: (...args: unknown[]) =>
    createAgentMock(...(args as Parameters<typeof createAgentMock>)),
  buildToolsMd: () => '# TOOLS\n',
  refreshTeamAgentsMd: vi.fn(),
}))
vi.mock('@/lib/hydrateTeams', () => ({ hydrateTeams: vi.fn(async () => {}) }))

// Import AFTER the mocks so the modal picks up the mocked createAgent.
const { CreateTeamModal } = await import('../CreateTeamModal')

const PROFILE: ProfileLike = {
  id: 'test-team',
  name: 'Test Team',
  emoji: '🧪',
  color: '#e94560',
  description: 'A test team',
  source: 'clawboo',
  category: 'engineering',
  tags: [],
  agents: [
    {
      name: 'Team Lead',
      role: 'Team Lead',
      soulTemplate: '# soul lead',
      identityTemplate: '# id lead',
      toolsTemplate: '# tools',
      agentsTemplate: '',
    },
    {
      name: 'Coder',
      role: 'Engineer',
      soulTemplate: '# soul coder',
      identityTemplate: '# id coder',
      toolsTemplate: '# tools',
      agentsTemplate: '',
    },
  ],
} as unknown as ProfileLike

// A roster with NO leadership-archetype role (neither "Content Writer" nor "Visual
// Designer" trips detectGenuineLeader) → the team deploys leaderless (Boo Zero leads).
const PROFILE_NO_LEADER: ProfileLike = {
  id: 'test-team-no-leader',
  name: 'No Leader Team',
  emoji: '🧪',
  color: '#e94560',
  description: 'A team with no in-house lead',
  source: 'clawboo',
  category: 'engineering',
  tags: [],
  agents: [
    {
      name: 'Content Writer',
      role: 'Content Writer',
      soulTemplate: '# soul w',
      identityTemplate: '# id w',
      toolsTemplate: '# tools',
      agentsTemplate: '',
    },
    {
      name: 'Visual Designer',
      role: 'Visual Designer',
      soulTemplate: '# soul d',
      identityTemplate: '# id d',
      toolsTemplate: '# tools',
      agentsTemplate: '',
    },
  ],
} as unknown as ProfileLike

const RUNTIMES = [
  { id: 'clawboo-native', hasCredential: true, connectionState: 'ready' },
  { id: 'claude-code', connectionState: 'ready', hasCredential: true },
  { id: 'codex', connectionState: 'needs-login' },
  { id: 'hermes', connectionState: 'not-installed' },
]

function baseHandlers(
  teamPost?: (body: unknown) => void,
  teamPatch?: (body: unknown) => void,
  configPatch?: (body: unknown) => void,
) {
  return [
    http.get('/api/runtimes', () => HttpResponse.json(RUNTIMES)),
    http.patch('/api/system/openclaw-config', async ({ request }) => {
      configPatch?.(await request.json())
      return HttpResponse.json({ ok: true })
    }),
    http.post('/api/teams', async ({ request }) => {
      const body = await request.json()
      teamPost?.(body)
      return HttpResponse.json({
        team: {
          id: 'team-1',
          name: 'Test Team',
          icon: '🧪',
          color: '#e94560',
          templateId: null,
          leaderAgentId: null,
          isArchived: 0,
          agentCount: 0,
          serverOrchestrated: true,
          createdAt: 1,
          updatedAt: 1,
        },
      })
    }),
    http.post('/api/personality', () => HttpResponse.json({ ok: true })),
    http.post('/api/teams/:id/agents', () => HttpResponse.json({ ok: true })),
    http.patch('/api/teams/:id', async ({ request }) => {
      teamPatch?.(await request.json())
      return HttpResponse.json({ team: {} })
    }),
    http.put('/api/boo-zero/team-briefs/:id', () => HttpResponse.json({ ok: true })),
    http.get('/api/agents', () =>
      HttpResponse.json({ defaultId: null, mainKey: null, agents: [], stale: false }),
    ),
    http.get('/api/teams', () => HttpResponse.json({ teams: [] })),
  ]
}

beforeEach(() => {
  createAgentMock.mockReset()
  createAgentMock.mockImplementation(async (name: string) => `id-${name}`)
  useSettingsModalStore.setState({ open: false, view: 'runtimes', runtimeIntent: null })
  // Gateway offline by default (native-first). Individual tests connect it.
  useConnectionStore.setState({ status: 'disconnected', client: null })
  // Reset the shared stores so a prior test's deploy can't leak agent/team names
  // into the dedup pass (which would rename "Team Lead" → "Team Lead 2").
  useFleetStore.setState({ agents: [] })
  useTeamStore.setState({ teams: [] })
})
afterEach(() => cleanup())

function renderModal(
  props: { onClose?: () => void; onCreated?: () => void; profile?: ProfileLike } = {},
) {
  return render(
    <ThemeProvider>
      <CreateTeamModal
        isOpen
        onClose={props.onClose ?? vi.fn()}
        onCreated={props.onCreated ?? vi.fn()}
        initialProfile={props.profile ?? PROFILE}
      />
    </ThemeProvider>,
  )
}

describe('CreateTeamModal per-agent runtime selector', () => {
  it('gives every agent (incl. the leader) a runtime dropdown, and badges the leader', async () => {
    server.use(...baseHandlers())
    renderModal()
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )
    // One "Leader" badge (the detected internal lead), not a locked native row.
    expect(screen.getAllByText('Leader')).toHaveLength(1)
  })

  it('degrades the marketplace OpenClaw default to Native when the Gateway is offline; an override drops the note', async () => {
    server.use(...baseHandlers())
    renderModal()
    // A marketplace team suggests OpenClaw for every agent; Gateway offline →
    // both degrade to Clawboo Native with an inline note.
    await waitFor(() =>
      expect(screen.getAllByText(/using Clawboo Native/i)).toHaveLength(2),
    )
    // Explicitly choosing a runtime on the Coder row removes its degraded note.
    await userEvent.click(screen.getAllByTestId('member-runtime-trigger')[1])
    await userEvent.click(screen.getByRole('option', { name: /clawboo native/i }))
    await waitFor(() =>
      expect(screen.getAllByText(/using Clawboo Native/i)).toHaveLength(1),
    )
  })

  it('native mode (status=connected, client=null) still degrades OpenClaw to Native — no live Gateway', async () => {
    // enterNativeMode sets status='connected' with a NULL client. OpenClaw must NOT be
    // treated as available on a bare status check — it needs a live client. So a marketplace
    // team (suggests OpenClaw) degrades to Clawboo Native, deployable Gateway-free.
    useConnectionStore.setState({ status: 'connected', client: null })
    server.use(...baseHandlers())
    renderModal()
    await waitFor(() =>
      expect(screen.getAllByText(/using Clawboo Native/i)).toHaveLength(2),
    )
  })

  it('a disabled coding option opens the Settings Runtimes pane (no runtime intent) and closes the modal', async () => {
    server.use(...baseHandlers())
    const onClose = vi.fn()
    renderModal({ onClose })
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )
    await userEvent.click(screen.getAllByTestId('member-runtime-trigger')[0])
    // Codex is needs-login → disabled → click opens the Settings modal's Runtimes
    // pane (Runtimes moved into Settings) and closes this modal, WITHOUT the
    // OpenClaw connect intent (a coding runtime lands on the plain Runtimes list).
    await userEvent.click(screen.getByRole('option', { name: /codex/i }))
    expect(useSettingsModalStore.getState().open).toBe(true)
    expect(useSettingsModalStore.getState().view).toBe('runtimes')
    expect(useSettingsModalStore.getState().runtimeIntent).toBeNull()
    expect(onClose).toHaveBeenCalled()
  })

  it('a disabled OpenClaw option opens the Gateway connect flow (runtime intent) and closes the modal', async () => {
    server.use(...baseHandlers())
    const onClose = vi.fn()
    renderModal({ onClose })
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )
    // Gateway offline → OpenClaw is disabled; clicking it hands the Runtimes panel a
    // one-shot `connect-openclaw` intent (which auto-opens the OpenClaw setup flow),
    // distinct from the coding runtimes' plain Runtimes route.
    await userEvent.click(screen.getAllByTestId('member-runtime-trigger')[0])
    await userEvent.click(screen.getByRole('option', { name: /openclaw/i }))
    expect(useSettingsModalStore.getState().open).toBe(true)
    expect(useSettingsModalStore.getState().view).toBe('runtimes')
    expect(useSettingsModalStore.getState().runtimeIntent).toBe('connect-openclaw')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('CreateTeamModal deploy', () => {
  it('Gateway offline: deploys every agent native (degraded) with tasks:false + tier-aware modelTier; team POST carries serverOrchestrated', async () => {
    let teamBody: Record<string, unknown> | undefined
    server.use(...baseHandlers((b) => (teamBody = b as Record<string, unknown>)))
    renderModal()
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )

    await userEvent.click(screen.getByRole('button', { name: /deploy team/i }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2))

    // The team POST requested server-orchestration.
    expect(teamBody?.['serverOrchestrated']).toBe(true)

    // Leader: native + LEADER prompt + tasks:false + modelTier leader.
    const leaderCall = createAgentMock.mock.calls.find((c) => c[0] === 'Team Lead')!
    expect(leaderCall[2]).toBe('clawboo-native')
    const leaderExec = leaderCall[3] as unknown as {
      systemPrompt: string
      tools: { tasks: boolean }
      modelTier: string
    }
    expect(leaderExec.tools.tasks).toBe(false)
    expect(leaderExec.modelTier).toBe('leader')
    expect(leaderExec.systemPrompt).toContain('delegate')
    expect(leaderExec.systemPrompt).not.toContain('<delegate')

    // Member: native + specialist tier.
    const memberCall = createAgentMock.mock.calls.find((c) => c[0] === 'Coder')!
    expect(memberCall[2]).toBe('clawboo-native')
    expect((memberCall[3] as unknown as { modelTier: string }).modelTier).toBe('specialist')
  })

  it('Gateway online: a marketplace team defaults to OpenClaw; overriding one member yields mixed runtimes', async () => {
    useConnectionStore.setState({ status: 'connected', client: {} as unknown as GatewayClient })
    server.use(...baseHandlers())
    renderModal()
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )

    // Override the Coder (2nd row) to Clawboo Native — the leader stays on the
    // OpenClaw default → a mixed team.
    await userEvent.click(screen.getAllByTestId('member-runtime-trigger')[1])
    await userEvent.click(screen.getByRole('option', { name: /clawboo native/i }))

    await userEvent.click(screen.getByRole('button', { name: /deploy team/i }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2))

    // Leader deployed on OpenClaw → the 2-arg createAgent(name, files) branch.
    const leaderCall = createAgentMock.mock.calls.find((c) => c[0] === 'Team Lead')!
    expect(leaderCall[2]).toBeUndefined()
    // Coder deployed native (the override).
    const memberCall = createAgentMock.mock.calls.find((c) => c[0] === 'Coder')!
    expect(memberCall[2]).toBe('clawboo-native')
  })

  it('tolerates one agent failing to create (continues; reports N of M)', async () => {
    server.use(...baseHandlers())
    const toastSpy = vi.spyOn(useToastStore.getState(), 'addToast')
    createAgentMock.mockReset()
    createAgentMock.mockResolvedValueOnce('id-lead').mockRejectedValueOnce(new Error('boom'))
    renderModal()
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )

    await userEvent.click(screen.getByRole('button', { name: /deploy team/i }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(
        toastSpy.mock.calls.some((c) =>
          String((c[0] as { message?: string }).message).includes('1 of 2'),
        ),
      ).toBe(true),
    )
    toastSpy.mockRestore()
  })

  it('OpenClaw member: a picked model deploys via the openclaw-config agentModel override (only for the picked member)', async () => {
    useConnectionStore.setState({ status: 'connected', client: {} as unknown as GatewayClient })
    const configPatches: Record<string, unknown>[] = []
    server.use(
      ...baseHandlers(undefined, undefined, (b) => configPatches.push(b as Record<string, unknown>)),
    )
    renderModal()
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )
    // Gateway online + marketplace team → both rows default OpenClaw → each shows a model picker.
    expect(screen.getAllByTestId('member-model-trigger')).toHaveLength(2)

    // Pick a model on the Leader row (index 0). OpenClaw catalog id = `anthropic/claude-sonnet-4-5`.
    await userEvent.click(screen.getAllByTestId('member-model-trigger')[0])
    await userEvent.click(screen.getByRole('option', { name: /Claude Sonnet 4\.5 · Anthropic/i }))

    await userEvent.click(screen.getByRole('button', { name: /deploy team/i }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2))

    // The leader (OpenClaw, id-Team Lead) got the per-agent override; the Coder (no pick) did not.
    await waitFor(() =>
      expect(
        configPatches.some(
          (p) =>
            typeof p['agentModel'] === 'object' &&
            (p['agentModel'] as Record<string, unknown>)['agentId'] === 'id-Team Lead' &&
            (p['agentModel'] as Record<string, unknown>)['model'] === 'anthropic/claude-sonnet-4-5',
        ),
      ).toBe(true),
    )
    expect(configPatches.filter((p) => 'agentModel' in p)).toHaveLength(1)
  })

  it('switching a member’s runtime clears its model override (no stale cross-runtime id)', async () => {
    useConnectionStore.setState({ status: 'connected', client: {} as unknown as GatewayClient })
    server.use(...baseHandlers())
    renderModal()
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )
    // Both default OpenClaw → pick a model on the Coder (row 1).
    await userEvent.click(screen.getAllByTestId('member-model-trigger')[1])
    await userEvent.click(screen.getByRole('option', { name: /Claude Haiku 4\.5 · Anthropic/i }))
    expect(screen.getAllByTestId('member-model-trigger')[1]).toHaveTextContent(/Claude Haiku 4\.5/i)

    // Switch the Coder to Clawboo Native → its model override is cleared → back to Recommended.
    await userEvent.click(screen.getAllByTestId('member-runtime-trigger')[1])
    await userEvent.click(screen.getByRole('option', { name: /clawboo native/i }))
    expect(screen.getAllByTestId('member-model-trigger')[1]).toHaveTextContent(/Recommended/i)
  })

  it('native member: a picked model spreads into the createAgent execConfig', async () => {
    // Gateway offline (default) → the marketplace team degrades both rows to Native.
    server.use(...baseHandlers())
    renderModal()
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )
    // Pick a native model on the Coder (row 1). Native ids are bare (`claude-haiku-4-5`).
    await userEvent.click(screen.getAllByTestId('member-model-trigger')[1])
    await userEvent.click(screen.getByRole('option', { name: /Claude Haiku 4\.5 · Anthropic/i }))

    await userEvent.click(screen.getByRole('button', { name: /deploy team/i }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2))

    const memberCall = createAgentMock.mock.calls.find((c) => c[0] === 'Coder')!
    const exec = memberCall[3] as unknown as {
      primaryModel?: string
      primaryProvider?: string
      envVar?: string
    }
    expect(exec.primaryModel).toBe('claude-haiku-4-5')
    expect(exec.primaryProvider).toBe('anthropic')
    expect(exec.envVar).toBe('ANTHROPIC_API_KEY')
  })

  it('hermes member: a picked model spreads into the createAgent execConfig as { provider, model }', async () => {
    // Hermes must be READY so its runtime option is selectable (default is not-installed).
    const runtimesReady = RUNTIMES.map((r) =>
      r.id === 'hermes' ? { ...r, connectionState: 'ready', hasCredential: true } : r,
    )
    // fetchRuntimes reads `body.runtimes` (the real server returns { runtimes, available });
    // a bare array leaves coding-runtime statuses empty → hermes would read as disabled.
    server.use(
      http.get('/api/runtimes', () => HttpResponse.json({ runtimes: runtimesReady })),
      ...baseHandlers(),
    )
    renderModal()
    await waitFor(() => expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2))

    // Switch the Coder (row 1) to Hermes → its model picker appears (Hermes now has one).
    await userEvent.click(screen.getAllByTestId('member-runtime-trigger')[1])
    await userEvent.click(screen.getByRole('option', { name: /hermes/i }))
    await waitFor(() => expect(screen.getAllByTestId('member-model-trigger')).toHaveLength(2))

    // Pick a Hermes OpenRouter model (the provider suffix disambiguates the label).
    await userEvent.click(screen.getAllByTestId('member-model-trigger')[1])
    await userEvent.click(screen.getByRole('option', { name: /Claude 3\.5 Haiku · OpenRouter/i }))

    await userEvent.click(screen.getByRole('button', { name: /deploy team/i }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2))

    // The Coder was created on the hermes source with the picked { provider, model }.
    const coderCall = createAgentMock.mock.calls.find((c) => c[0] === 'Coder')!
    expect(coderCall[2]).toBe('hermes')
    expect(coderCall[3]).toEqual({ provider: 'openrouter', model: 'anthropic/claude-3.5-haiku' })
  })

  it('a team with no genuine leadership role deploys leaderless (no badge, leaderAgentId null, all specialists)', async () => {
    let patchBody: Record<string, unknown> | undefined
    server.use(...baseHandlers(undefined, (b) => (patchBody = b as Record<string, unknown>)))
    renderModal({ profile: PROFILE_NO_LEADER })
    await waitFor(() =>
      expect(screen.getAllByTestId('member-runtime-trigger')).toHaveLength(2),
    )
    // No in-house lead is detected → NO "Leader" badge (Boo Zero coordinates the team).
    expect(screen.queryByText('Leader')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /deploy team/i }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2))

    // No agent got the native LEADER prompt/tier — every native agent is a specialist.
    for (const call of createAgentMock.mock.calls) {
      expect((call[3] as { modelTier?: string } | undefined)?.modelTier).toBe('specialist')
    }
    // leaderAgentId is PATCHed as null (not forced to the first agent).
    await waitFor(() => expect(patchBody).toBeDefined())
    expect(patchBody?.['leaderAgentId']).toBeNull()
  })
})
