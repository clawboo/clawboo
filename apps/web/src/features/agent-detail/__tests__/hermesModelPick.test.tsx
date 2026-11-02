// A model picked on a Hermes agent's page shows in the fleet store at once and
// is put back when the save fails, so the page never shows a model or provider
// the agent does not have.

import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { saveHermesModelPick } from '../hermesModelPick'

const AGENT = {
  id: 'hermes-1',
  name: 'Hermes Boo',
  status: 'idle',
  sessionKey: null,
  model: 'openai/gpt-4o-mini',
  createdAt: null,
  streamingText: null,
  runId: null,
  lastSeenAt: null,
  teamId: null,
  runtime: 'hermes',
  execConfig: { provider: 'openrouter', model: 'openai/gpt-4o-mini' },
} as unknown as AgentState

const stored = () => useFleetStore.getState().agents.find((a) => a.id === AGENT.id)!

describe('saveHermesModelPick', () => {
  beforeEach(() => {
    useFleetStore.setState({ agents: [AGENT] })
  })

  it('keeps the pick once the save succeeds', async () => {
    server.use(
      http.patch('/api/agents/hermes-1/model', () =>
        HttpResponse.json({
          ok: true,
          model: 'anthropic/claude-haiku-4.5',
          provider: 'openrouter',
        }),
      ),
    )
    expect(await saveHermesModelPick(AGENT, 'anthropic/claude-haiku-4.5', true)).toBe(true)
    expect(stored().model).toBe('anthropic/claude-haiku-4.5')
    expect(stored().execConfig).toMatchObject({ model: 'anthropic/claude-haiku-4.5' })
  })

  it('puts the model and provider back when the save fails', async () => {
    server.use(
      http.patch('/api/agents/hermes-1/model', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    expect(await saveHermesModelPick(AGENT, 'openai-codex/plan-model-a', false)).toBe(false)
    expect(stored().model).toBe('openai/gpt-4o-mini')
    expect(stored().execConfig).toEqual({ provider: 'openrouter', model: 'openai/gpt-4o-mini' })
  })
})
