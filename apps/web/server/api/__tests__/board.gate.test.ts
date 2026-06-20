// The intrinsic verification gate over the GENERIC board PATCH route: a task with
// a non-promotable verdict cannot reach `done` via a plain client PATCH, and the
// only bypass — `humanOverride` — is recorded in the audit log. Sandboxes $HOME so
// the sqlite db lands in a throwaway dir (boardUpdatePATCH reads getDbPath()).

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createDb,
  createTask,
  listGovernanceAudit,
  setTaskVerification,
  updateStatus,
} from '@clawboo/db'
import type { VerificationResult } from '@clawboo/governance'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { boardUpdatePATCH } from '../board'

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
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
  return { res, statusCode: () => code, body: () => payload }
}
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

function failVerdict(): VerificationResult {
  return {
    status: 'fail',
    attempts: [
      {
        attempt: 1,
        at: 0,
        deterministic: {
          command: 'pnpm test',
          exitCode: 1,
          passed: false,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 1,
          timedOut: false,
        },
        critic: {
          ran: false,
          findings: [],
          reviewerRuntime: null,
          reviewerModel: null,
          reviewedSha: null,
        },
        status: 'fail',
        structuredError: null,
      },
    ],
    debtNotes: [],
    updatedAt: 0,
  }
}

describe('board PATCH verification gate (intrinsic + audited override)', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-gate-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function redGatedTask(): string {
    const db = createDb(getDbPath())
    const t = createTask(db, { title: 'x' })
    updateStatus(db, t.id, 'in_progress')
    updateStatus(db, t.id, 'in_review')
    setTaskVerification(db, t.id, failVerdict())
    return t.id
  }

  it('a plain PATCH of a RED-gated in_review task → done is REJECTED with 409', () => {
    const taskId = redGatedTask()
    const r = mockRes()
    boardUpdatePATCH(req({ params: { taskId }, body: { status: 'done' } }), r.res)
    expect(r.statusCode()).toBe(409)
    expect((r.body() as { error: string }).error).toBe('verification_required')
  })

  it('humanOverride forces it through AND writes an audit row', () => {
    const taskId = redGatedTask()
    const r = mockRes()
    boardUpdatePATCH(
      req({ params: { taskId }, body: { status: 'done', humanOverride: true } }),
      r.res,
    )
    expect(r.statusCode()).toBe(200)
    const audit = listGovernanceAudit(createDb(getDbPath()), { eventType: 'verification' })
    expect(audit.some((row) => String(row.summary).includes('override'))).toBe(true)
  })
})
