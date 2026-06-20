import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { VerificationResult } from '@clawboo/governance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { claimTask, createTask, getTask, releaseTask, updateStatus } from '../repository'
import { getTaskVerification, setTaskVerification } from '../verification'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-verify-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Build a verdict. `detPassed` overrides the deterministic-gate result (defaults
 *  to true for `pass`, false otherwise) so the debt cases can model a green vs red
 *  gate independently of the verdict status. */
function result(
  status: VerificationResult['status'],
  detPassed = status === 'pass',
): VerificationResult {
  return {
    status,
    attempts: [
      {
        attempt: 1,
        at: Date.now(),
        deterministic: {
          command: 'pnpm test',
          exitCode: detPassed ? 0 : 1,
          passed: detPassed,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 5,
          timedOut: false,
        },
        critic: {
          ran: false,
          findings: [],
          reviewerRuntime: null,
          reviewerModel: null,
          reviewedSha: null,
        },
        status: status === 'completed_with_debt' ? 'completed_with_debt' : status,
        structuredError: null,
      },
    ],
    debtNotes: [],
    updatedAt: Date.now(),
  }
}

function toInReview(taskId: string): void {
  updateStatus(db, taskId, 'in_progress')
  updateStatus(db, taskId, 'in_review')
}

describe('task verification storage', () => {
  it('round-trips the typed verdict (null until set)', () => {
    const t = createTask(db, { title: 'x' })
    expect(getTaskVerification(db, t.id)).toBeNull()
    setTaskVerification(db, t.id, result('pass'))
    expect(getTaskVerification(db, t.id)?.status).toBe('pass')
  })
})

describe('in_review → done gate (intrinsic, un-bypassable except humanOverride)', () => {
  it('a task with NO verdict is unverified, not failing — `done` is allowed', () => {
    const t = createTask(db, { title: 'x' })
    toInReview(t.id)
    expect(updateStatus(db, t.id, 'done').ok).toBe(true)
    expect(getTask(db, t.id)?.status).toBe('done')
  })

  it('a PASS verdict allows `done` (no opts needed — the gate is intrinsic)', () => {
    const t = createTask(db, { title: 'x' })
    toInReview(t.id)
    setTaskVerification(db, t.id, result('pass'))
    const r = updateStatus(db, t.id, 'done')
    expect(r.ok).toBe(true)
    expect(r.task?.status).toBe('done')
  })

  it('a FAIL verdict BLOCKS `done` via the plain 3-arg call — no caller can bypass it', () => {
    const t = createTask(db, { title: 'x' })
    toInReview(t.id)
    setTaskVerification(db, t.id, result('fail'))
    const r = updateStatus(db, t.id, 'done')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verification_required')
    expect(getTask(db, t.id)?.status).toBe('in_review')
  })

  it('humanOverride is the ONLY way past a failing verdict', () => {
    const t = createTask(db, { title: 'x' })
    toInReview(t.id)
    setTaskVerification(db, t.id, result('fail'))
    const r = updateStatus(db, t.id, 'done', { humanOverride: true })
    expect(r.ok).toBe(true)
    expect(r.task?.status).toBe('done')
  })

  it('completed_with_debt over a GREEN deterministic gate is promotable → `done`', () => {
    const t = createTask(db, { title: 'x' })
    toInReview(t.id)
    setTaskVerification(db, t.id, result('completed_with_debt', true))
    expect(updateStatus(db, t.id, 'done').ok).toBe(true)
    expect(getTask(db, t.id)?.status).toBe('done')
  })

  it('completed_with_debt over a RED deterministic gate is NOT promotable → blocked', () => {
    const t = createTask(db, { title: 'x' })
    toInReview(t.id)
    setTaskVerification(db, t.id, result('completed_with_debt', false))
    const r = updateStatus(db, t.id, 'done')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verification_required')
    expect(getTask(db, t.id)?.status).toBe('in_review')
  })
})

describe('verdict cleared on release/reclaim (the cross-runtime rebind boundary)', () => {
  it('releaseTask clears a stale FAIL verdict so a re-claimed task can land done', () => {
    const t = createTask(db, { title: 'x', status: 'todo' })
    // A prior runtime claimed the task and failed verification.
    expect(claimTask(db, t.id, 'runtime-a', 'claude-code').ok).toBe(true) // todo → in_progress
    setTaskVerification(db, t.id, result('fail'))
    expect(getTaskVerification(db, t.id)?.status).toBe('fail')

    releaseTask(db, t.id) // in_progress → todo, verdict cleared
    expect(getTaskVerification(db, t.id)).toBeNull()

    // A fresh runtime re-claims and completes — the stale verdict no longer gates it.
    expect(claimTask(db, t.id, 'runtime-b', 'openclaw').ok).toBe(true)
    updateStatus(db, t.id, 'in_review')
    expect(updateStatus(db, t.id, 'done').ok).toBe(true)
    expect(getTask(db, t.id)?.status).toBe('done')
  })

  it('updateStatus(→todo) also clears the verdict (the in-browser release path)', () => {
    const t = createTask(db, { title: 'x', status: 'todo' })
    expect(claimTask(db, t.id, 'runtime-a', 'openclaw').ok).toBe(true) // todo → in_progress
    setTaskVerification(db, t.id, result('fail'))
    const r = updateStatus(db, t.id, 'todo') // in_progress → todo (the release)
    expect(r.ok).toBe(true)
    expect(getTaskVerification(db, t.id)).toBeNull()
  })
})
