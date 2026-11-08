// While the work folder move runs at boot, the server answers /api/health with
// `migrating` and its progress, and every other request with 503 and
// Retry-After, so a supervisor waiting on health sees progress, never silence,
// and nothing runs before the folders are in place.

import { PassThrough } from 'node:stream'

import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it } from 'vitest'

import {
  holdForWorkDirMove,
  releaseWorkDirMoveHold,
  workDirMoveProgress,
} from '../workDirMigration'
import { refuseUpgradeWhileMoving, refuseWhileMoving } from '../workDirMoveGate'

interface Answer {
  status: number
  headers: Record<string, string>
  body: unknown
  passed: boolean
}

function ask(method: string, path: string): Answer {
  const answer: Answer = { status: 200, headers: {}, body: undefined, passed: false }
  const res = {
    status(code: number) {
      answer.status = code
      return res
    },
    setHeader(name: string, value: string) {
      answer.headers[name.toLowerCase()] = value
    },
    json(body: unknown) {
      answer.body = body
      return res
    },
  } as unknown as Response
  const next: NextFunction = () => {
    answer.passed = true
  }
  refuseWhileMoving({ method, path } as Request, res, next)
  return answer
}

// The move itself ends the hold when it returns (workDirMigration.test.ts
// covers a real one); here it is ended directly.
async function endHold(): Promise<void> {
  releaseWorkDirMoveHold()
}

afterEach(async () => {
  await endHold()
})

describe('the server while the work folder move runs', () => {
  it('passes every request through when no move is running', () => {
    expect(workDirMoveProgress()).toBeNull()
    expect(ask('GET', '/api/health').passed).toBe(true)
    expect(ask('GET', '/api/tasks').passed).toBe(true)
  })

  it('answers /api/health with migrating and the count, and 503 for the rest', () => {
    holdForWorkDirMove()
    const health = ask('GET', '/api/health')
    expect(health.passed).toBe(false)
    expect(health.status).toBe(200)
    expect(health.body).toEqual({
      ok: false,
      status: 'migrating',
      migration: { total: 0, done: 0, left: 0 },
    })
    for (const [method, path] of [
      ['GET', '/api/tasks'],
      ['POST', '/api/board/t1/workspace'],
      ['GET', '/'],
      ['POST', '/api/health/recheck'],
    ]) {
      const other = ask(method, path)
      expect(other.passed).toBe(false)
      expect(other.status).toBe(503)
      expect(other.headers['retry-after']).toBe('2')
      expect(other.body).toMatchObject({ status: 'migrating' })
    }
  })

  it('refuses a WebSocket upgrade while it runs, and lets one through after', async () => {
    holdForWorkDirMove()
    const socket = new PassThrough()
    let written = ''
    socket.on('data', (d) => (written += String(d)))
    expect(refuseUpgradeWhileMoving(socket)).toBe(true)
    expect(written).toMatch(/^HTTP\/1\.1 503/)
    await endHold()
    expect(refuseUpgradeWhileMoving(new PassThrough())).toBe(false)
  })

  it('lets requests through again once the hold ends', async () => {
    holdForWorkDirMove()
    expect(workDirMoveProgress()).not.toBeNull()
    await endHold()
    expect(workDirMoveProgress()).toBeNull()
    expect(ask('GET', '/api/tasks').passed).toBe(true)
  })
})
