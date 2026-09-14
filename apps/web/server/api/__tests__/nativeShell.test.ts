// The switch that decides whether a native Boo may ASK to run commands.
//
// Two properties carry it. It must refuse a runtime it cannot govern, rather
// than accepting a setting nothing will read: that is the exact defect the
// Permissions tab shipped with, and it left an orphaned entry in OpenClaw's
// store as evidence. And it must answer with what is STORED rather than what was
// asked for, so a caller cannot be told a gate moved when it did not.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

let runtime = 'clawboo-native'
let config: Record<string, unknown> | null = null
const saved: Record<string, unknown>[] = []

vi.mock('../../lib/db', () => ({ getDb: () => ({}) }))
vi.mock('../../lib/agentSource', () => ({
  getRegistry: () => ({
    source: { getAgent: async () => (runtime ? { id: 'boo', runtime } : null) },
  }),
}))
vi.mock('../../lib/runtimes/native/agentConfigStore', () => ({
  loadAgentConfig: () => config,
  saveAgentConfig: (_db: unknown, next: Record<string, unknown>) => {
    saved.push(next)
    config = next
  },
}))

const { nativeShellGET, nativeShellPOST } = await import('../nativeShell')

function mockRes(): {
  res: Response
  done: Promise<{ code: number; body: Record<string, unknown> }>
} {
  let code = 200
  let settle: (v: { code: number; body: Record<string, unknown> }) => void = () => {}
  const done = new Promise<{ code: number; body: Record<string, unknown> }>((r) => {
    settle = r
  })
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      settle({ code, body: (b ?? {}) as Record<string, unknown> })
      return this
    },
  } as unknown as Response
  return { res, done }
}

const req = (body?: unknown): Request =>
  ({ params: { agentId: 'boo' }, query: {}, body }) as unknown as Request

beforeEach(() => {
  runtime = 'clawboo-native'
  saved.length = 0
  config = {
    tools: { memory: true, tools: true, tasks: 'read', teamchat: true },
    primaryModel: 'm',
  }
})

describe('GET /api/agents/:id/shell', () => {
  it('reports an absent switch as off, which is what the runtime does', async () => {
    const { res, done } = mockRes()
    await nativeShellGET(req(), res)
    expect(await done).toEqual({ code: 200, body: { ok: true, enabled: false } })
  })

  it('reports it on once it is set', async () => {
    ;(config!['tools'] as Record<string, unknown>)['shell'] = true
    const { res, done } = mockRes()
    await nativeShellGET(req(), res)
    expect((await done).body['enabled']).toBe(true)
  })

  it('refuses a runtime this switch cannot govern', async () => {
    // An OpenClaw Boo's shell is governed by its Gateway policy. Accepting the
    // call here would be a control that reports success and changes nothing.
    runtime = 'openclaw'
    const { res, done } = mockRes()
    await nativeShellGET(req(), res)
    expect((await done).code).toBe(400)
  })
})

describe('POST /api/agents/:id/shell', () => {
  it('turns it on and keeps every other tool setting', async () => {
    // The tools record also carries memory, tasks and teamchat. Rebuilding it
    // from the fields this route knows about would silently drop the rest.
    const { res, done } = mockRes()
    await nativeShellPOST(req({ enabled: true }), res)
    expect((await done).body['enabled']).toBe(true)
    expect(saved[0]?.['tools']).toEqual({
      memory: true,
      tools: true,
      tasks: 'read',
      teamchat: true,
      shell: true,
    })
    expect(saved[0]?.['primaryModel']).toBe('m')
  })

  it('turns it off again', async () => {
    ;(config!['tools'] as Record<string, unknown>)['shell'] = true
    const { res, done } = mockRes()
    await nativeShellPOST(req({ enabled: false }), res)
    expect((await done).body['enabled']).toBe(false)
  })

  it('answers with what is STORED, not what was asked for', async () => {
    // The route re-reads after writing. A caller is told the state of the gate,
    // never an echo of its own request.
    const { res, done } = mockRes()
    await nativeShellPOST(req({ enabled: true }), res)
    await done
    ;(config!['tools'] as Record<string, unknown>)['shell'] = false
    const second = mockRes()
    await nativeShellGET(req(), second.res)
    expect((await second.done).body['enabled']).toBe(false)
  })

  it('rejects a body that is not a boolean rather than guessing', async () => {
    for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }, undefined]) {
      const { res, done } = mockRes()
      await nativeShellPOST(req(bad), res)
      expect((await done).code).toBe(400)
    }
    expect(saved).toHaveLength(0)
  })

  it('writes nothing for a runtime it cannot govern', async () => {
    runtime = 'openclaw'
    const { res, done } = mockRes()
    await nativeShellPOST(req({ enabled: true }), res)
    expect((await done).code).toBe(400)
    expect(saved).toHaveLength(0)
  })
})
