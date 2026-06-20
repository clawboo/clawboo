import { describe, expect, it } from 'vitest'

import { assertExhaustive, createAsyncQueue, RuntimeRegistry } from '../index'
import type { RuntimeAdapter, RuntimeEvent } from '../index'

const stubAdapter = (id: string): RuntimeAdapter => ({
  id,
  participantKind: 'agent',
  capabilities: () => ({
    streaming: true,
    mcp: false,
    worktrees: false,
    resume: false,
    toolApproval: false,
    models: [],
  }),
  health: async () => ({ ok: true }),
  start: async (_task, opts) => ({ adapterId: id, sessionKey: opts.sessionKey, runId: null }),
  events: () => {
    const q = createAsyncQueue<RuntimeEvent>()
    q.close()
    return q
  },
  abort: async () => {},
  setModel: async () => {},
  writeContext: async () => {},
})

describe('RuntimeRegistry', () => {
  it('registers, gets, lists, and unregisters', () => {
    const r = new RuntimeRegistry()
    expect(r.has('x')).toBe(false)
    const a = stubAdapter('x')
    r.register(a)
    expect(r.get('x')).toBe(a)
    expect(r.has('x')).toBe(true)
    expect(r.ids()).toEqual(['x'])
    expect(r.list()).toEqual([a])
    r.unregister('x')
    expect(r.has('x')).toBe(false)
    expect(r.get('x')).toBeUndefined()
  })

  it('overwrites on duplicate id', () => {
    const r = new RuntimeRegistry()
    const a1 = stubAdapter('x')
    const a2 = stubAdapter('x')
    r.register(a1)
    r.register(a2)
    expect(r.get('x')).toBe(a2)
    expect(r.ids().length).toBe(1)
  })
})

describe('createAsyncQueue', () => {
  it('pushes then pulls in FIFO order', async () => {
    const q = createAsyncQueue<number>()
    q.push(1)
    q.push(2)
    const it = q[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe(1)
    expect((await it.next()).value).toBe(2)
  })

  it('resolves a pending next() when a value arrives later', async () => {
    const q = createAsyncQueue<number>()
    const it = q[Symbol.asyncIterator]()
    const pending = it.next()
    q.push(42)
    expect((await pending).value).toBe(42)
  })

  it('close() ends iteration', async () => {
    const q = createAsyncQueue<number>()
    const it = q[Symbol.asyncIterator]()
    const pending = it.next()
    q.close()
    expect((await pending).done).toBe(true)
    expect(q.closed).toBe(true)
  })

  it('drops the oldest item at max capacity', async () => {
    const q = createAsyncQueue<number>({ max: 2 })
    q.push(1)
    q.push(2)
    q.push(3) // drops 1
    const it = q[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe(2)
    expect((await it.next()).value).toBe(3)
  })

  it('return() closes the stream', async () => {
    const q = createAsyncQueue<number>()
    const it = q[Symbol.asyncIterator]()
    await it.return?.()
    expect(q.closed).toBe(true)
  })
})

describe('assertExhaustive', () => {
  it('throws when reached', () => {
    expect(() => assertExhaustive('unreachable' as never)).toThrow(/Unhandled RuntimeEvent/)
  })
})
