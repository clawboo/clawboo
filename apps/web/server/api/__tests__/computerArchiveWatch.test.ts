// An agent archived by its source loses its links, live views and control at
// once, so bringing it back (same id, same row) never revives an old link.

import { describe, expect, it, vi } from 'vitest'

const forgotten = vi.hoisted(() => [] as string[])
const feed = vi.hoisted(() => {
  const waiting: ((e: unknown) => void)[] = []
  const queued: unknown[] = []
  return {
    push(e: unknown) {
      const w = waiting.shift()
      if (w) w(e)
      else queued.push(e)
    },
    async *events() {
      for (;;) {
        yield queued.length > 0 ? queued.shift() : await new Promise((r) => waiting.push(r))
      }
    },
  }
})

vi.mock('../../lib/agentSource', () => ({
  getRegistry: () => ({ registry: { list: () => [{ events: () => feed.events() }] } }),
}))
vi.mock('../../lib/desktop/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/desktop/links')>()),
  revokeAllLinks: (agentId: string) => {
    forgotten.push(agentId)
    return 0
  },
}))

const { watchAgentArchives } = await import('../computer')

describe('watchAgentArchives', () => {
  it('forgets an agent the moment its source archives it, and nothing else', async () => {
    watchAgentArchives()
    feed.push({ kind: 'agent-status', agentId: 'a1', status: 'idle', at: 1 })
    feed.push({ kind: 'agent-archived', agentId: 'a2', at: 2 })
    await vi.waitFor(() => expect(forgotten).toEqual(['a2']))
  })
})
