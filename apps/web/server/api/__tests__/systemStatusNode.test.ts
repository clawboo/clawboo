// What GET /api/system/status says about the Node it runs on, and about the
// Gateway while nothing uses it.
//
// The SPA prints `node.required` and decides on `node.sufficient`, so both must
// come from @clawboo/protocol's OpenClaw range, never from a major-version
// check. OpenClaw detection, the Gateway probe and the agent registry are
// stubbed, and the state dir is a fresh temp dir, so nothing here touches a real
// install or its database.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OPENCLAW_NODE_REQUIREMENT } from '@clawboo/protocol'

import { systemStatusGET } from '../system'

vi.mock('../../lib/openclawDetect', async (orig) => ({
  ...(await orig<typeof import('../../lib/openclawDetect')>()),
  detectOpenClaw: async () => ({ installed: false, version: null, path: null }),
}))

const probe = vi.hoisted(() => ({
  inUse: true,
  reachable: false,
  calls: 0,
}))

vi.mock('../../lib/processManager', async (orig) => ({
  ...(await orig<typeof import('../../lib/processManager')>()),
  readGatewayPid: () => null,
  probeGatewayPort: async () => {
    probe.calls += 1
    return probe.reachable
  },
}))

vi.mock('../../lib/agentSource', () => ({
  getRegistry: () => ({ source: { isInUse: () => probe.inUse } }),
}))

function mockRes(): { res: Response; status: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, status: () => code, body: () => payload }
}

describe('GET /api/system/status: node', () => {
  const realVersion = Object.getOwnPropertyDescriptor(process, 'version')!
  const savedStateDir = process.env['OPENCLAW_STATE_DIR']
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-system-status-'))
    process.env['OPENCLAW_STATE_DIR'] = stateDir
  })

  afterEach(() => {
    Object.defineProperty(process, 'version', realVersion)
    if (savedStateDir === undefined) delete process.env['OPENCLAW_STATE_DIR']
    else process.env['OPENCLAW_STATE_DIR'] = savedStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  it.each([
    ['v22.23.2', false],
    ['v24.16.0', false],
    ['v24.22.1', true],
    ['v25.9.0', false],
    ['v26.12.1', true],
  ])('on Node %s reports sufficient: %s, with the OpenClaw range', async (version, sufficient) => {
    Object.defineProperty(process, 'version', { ...realVersion, value: version })
    const { res, status, body } = mockRes()
    await systemStatusGET({} as Request, res)
    expect(status()).toBe(200)
    expect(body()).toMatchObject({
      node: { version, sufficient, required: OPENCLAW_NODE_REQUIREMENT },
    })
  })
})

describe('GET /api/system/status: a Gateway nothing uses', () => {
  const savedStateDir = process.env['OPENCLAW_STATE_DIR']
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-system-status-'))
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    probe.inUse = true
    probe.reachable = true
    probe.calls = 0
  })

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env['OPENCLAW_STATE_DIR']
    else process.env['OPENCLAW_STATE_DIR'] = savedStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('does not probe the port, and says not in use', async () => {
    // A probe is a connection, and a connection starts a Gateway that a service
    // manager starts on its first one. The dashboard reads this on every load.
    probe.inUse = false
    const { res, body } = mockRes()
    await systemStatusGET({} as Request, res)
    expect(probe.calls).toBe(0)
    expect(body()).toMatchObject({ gateway: { inUse: false, running: false } })
  })

  it('probes the port once something uses the Gateway', async () => {
    const { res, body } = mockRes()
    await systemStatusGET({} as Request, res)
    expect(probe.calls).toBe(1)
    expect(body()).toMatchObject({ gateway: { inUse: true, running: true } })
  })
})
