// A key connected or disconnected on the Providers page reaches the keys Hermes's
// profiles hold at once, not at each profile's next run.

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  keySyncs: 0,
  connected: [] as string[],
  removed: [] as string[],
}))

vi.mock('../../lib/providerKeys', () => ({
  connectProviderKey: (id: string) => state.connected.push(id),
  disconnectProviderKey: (id: string) => state.removed.push(id),
  isKnownProvider: (id: string) => id === 'openrouter',
  providerStatus: () => [],
}))
vi.mock('../../lib/memoryEmbedding', () => ({ onEmbeddingKeysChanged: () => undefined }))
vi.mock('../../lib/runtimes/hermes', () => ({
  syncHermesProfileKeys: async () => {
    state.keySyncs += 1
  },
}))

import { providerConnectPOST, providerDisconnectPOST } from '../providers'

function call(
  handler: (req: Request, res: Response) => void,
  params: Record<string, string>,
  body: unknown = {},
): number {
  let status = 200
  const res = {
    status(code: number) {
      status = code
      return res
    },
    json() {
      return res
    },
  } as unknown as Response
  handler({ params, body } as unknown as Request, res)
  return status
}

describe("the Providers page and Hermes's profiles", () => {
  beforeEach(() => {
    state.keySyncs = 0
    state.connected = []
    state.removed = []
  })

  it('a connected or replaced key reaches the profiles', () => {
    expect(call(providerConnectPOST, { id: 'openrouter' }, { apiKey: 'sk-or-new' })).toBe(200)
    expect(state.connected).toEqual(['openrouter'])
    expect(state.keySyncs).toBe(1)
  })

  it('a disconnected key leaves the profiles', () => {
    expect(call(providerDisconnectPOST, { id: 'openrouter' })).toBe(200)
    expect(state.removed).toEqual(['openrouter'])
    expect(state.keySyncs).toBe(1)
  })

  it('a refused request changes nothing', () => {
    expect(call(providerConnectPOST, { id: 'nope' }, { apiKey: 'x' })).toBe(400)
    expect(call(providerDisconnectPOST, { id: 'nope' })).toBe(400)
    expect(state.keySyncs).toBe(0)
  })
})
