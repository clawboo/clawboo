// Eval smoke route: the on-demand, deterministic, network-free smoke run. Returns
// a valid SuiteReport (all-pass on the deterministic suite) with NO provider keys
// set. It runs against ephemeral throwaway boards, so the real (sandboxed) DB
// stays empty. Sandboxes $HOME.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { evalSmokePOST } from '../evalSmoke'

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
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

interface SuiteReportLike {
  tasks: { taskId: string; passAt1: number }[]
  passAt1: number
  passPowK: number
  k: number
}

describe('eval smoke REST', () => {
  let home: string
  let prevHome: string | undefined
  const keyVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const
  const prevKeys: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-eval-rest-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    // Prove the smoke path is network-free: strip any provider keys for the test.
    for (const k of keyVars) {
      prevKeys[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    for (const k of keyVars) {
      if (prevKeys[k] === undefined) delete process.env[k]
      else process.env[k] = prevKeys[k]
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('runs the deterministic smoke suite and returns an all-pass SuiteReport (no keys)', async () => {
    const r = mockRes()
    await evalSmokePOST(req({ body: { trials: 1 } }), r.res)
    expect(r.status()).toBe(200)

    const report = r.body() as SuiteReportLike
    expect(report.tasks.length).toBeGreaterThanOrEqual(5)
    expect(report.passAt1).toBe(1)
    expect(report.passPowK).toBe(1)
    expect(report.k).toBe(1)
    expect(report.tasks.every((t) => t.passAt1 === 1)).toBe(true)
  })

  it('clamps an out-of-range trials request (cannot be a load generator)', async () => {
    const r = mockRes()
    await evalSmokePOST(req({ body: { trials: 9999, k: 9999 } }), r.res)
    expect(r.status()).toBe(200)
    const report = r.body() as SuiteReportLike
    expect(report.k).toBeLessThanOrEqual(3)
    expect(report.passAt1).toBe(1)
  })
})
