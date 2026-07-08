import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgent } from '../createAgent'

function stubFetch(): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => ({ agent: { id: 'agent-x' } }),
        text: async () => '',
      } as unknown as Response
    }),
  )
  return { bodies }
}

describe('createAgent sourceId + execConfig plumbing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('forwards sourceId + execConfig to POST /api/agents', async () => {
    const { bodies } = stubFetch()
    const id = await createAgent('Coder', { soul: 's' }, 'claude-code', {
      systemPrompt: 'p',
      modelTier: 'leader',
    })
    expect(id).toBe('agent-x')
    expect(bodies[0]).toMatchObject({
      name: 'Coder',
      sourceId: 'claude-code',
      execConfig: { systemPrompt: 'p', modelTier: 'leader' },
      files: { 'SOUL.md': 's' },
    })
  })

  it('omits sourceId/execConfig for the legacy 2-arg call (backward compatible)', async () => {
    const { bodies } = stubFetch()
    await createAgent('Boo', { soul: 's' })
    const body = bodies[0]!
    expect('sourceId' in body).toBe(false)
    expect('execConfig' in body).toBe(false)
  })
})
