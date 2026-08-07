// Standing guard: the server opens ONE SQLite connection per process and
// bootstraps the schema ONCE, however many requests it serves.
//
// Two halves, because neither covers the other:
//
//  1. A RUNTIME burst through real handlers, asserting `dbOpenStats()` deltas.
//     Deltas, never absolutes — other module-load-time work may open databases.
//     No timing assertions: CI shares runners and the jsdom project runs
//     concurrently, so a millisecond threshold would flake and get raised until it
//     asserted nothing. The connection count IS the perf property, not a proxy
//     for it.
//  2. A SOURCE walk, because the runtime half only covers the handlers it calls —
//     the background tickers, the reaper, the MCP supervisor and worktrees.ts are
//     migrated too and no unit test drives them.
//
// Sandboxes CLAWBOO_HOME rather than HOME: `resolveClawbooDir` checks it first
// and it is portable (os.homedir() reads USERPROFILE on Windows).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dbOpenStats, getComments, listTasks, type DbTask } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  boardCommentPOST,
  boardCreatePOST,
  boardGetGET,
  boardListGET,
  boardUpdatePATCH,
} from '../../api/board'
import { obsStreamGET } from '../../api/obs'
import { getDb, resetDb } from '../db'

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

/** A mock SSE req/res that captures the close handler, so we can fire teardown. */
function mockSse(): { req: Request; res: Response; close: () => void } {
  let closeHandler: (() => void) | null = null
  const res = {
    writeHead() {
      return this
    },
    write() {
      return true
    },
    flushHeaders() {},
    on() {
      return this
    },
  } as unknown as Response
  const reqObj = {
    query: {},
    params: {},
    headers: {},
    on(ev: string, cb: () => void) {
      if (ev === 'close') closeHandler = cb
    },
  } as unknown as Request
  return { req: reqObj, res, close: () => closeHandler?.() }
}

describe('the shared connection — a request burst opens nothing', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-shared-conn-'))
    prevHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home
  })

  afterEach(async () => {
    // Close BEFORE removing the dir — Windows refuses to remove a directory that
    // still holds an open file.
    resetDb()
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('memoises: every getDb() in a process is the same handle', () => {
    const first = getDb()
    for (let i = 0; i < 10; i += 1) expect(getDb()).toBe(first)
  })

  it('a cold start opens exactly one connection and bootstraps the schema once', () => {
    const before = dbOpenStats()
    getDb()
    const after = dbOpenStats()

    expect(after.connectionsOpened - before.connectionsOpened).toBe(1)
    expect(after.schemaBootstraps - before.schemaBootstraps).toBe(1)
  })

  it('a burst of 60 board READS opens no connection and re-runs no DDL', () => {
    // Warm up first so the cold open is not folded into the burst delta.
    boardListGET(req(), mockRes().res)
    const create = mockRes()
    boardCreatePOST(req({ body: { title: 'burst', teamId: 'team-burst' } }), create.res)
    const taskId = (create.body() as { task: DbTask }).task.id

    const before = dbOpenStats()
    for (let i = 0; i < 50; i += 1) boardListGET(req(), mockRes().res)
    for (let i = 0; i < 5; i += 1) boardGetGET(req({ params: { taskId } }), mockRes().res)
    for (let i = 0; i < 5; i += 1) {
      boardListGET(req({ query: { ready: 'true' } }), mockRes().res)
    }
    const after = dbOpenStats()

    expect(after.connectionsOpened - before.connectionsOpened).toBe(0)
    // A separate regression: reusing the connection but still calling
    // ensureSchema per request would keep connectionsOpened flat.
    expect(after.schemaBootstraps - before.schemaBootstraps).toBe(0)
  })

  it('a burst of board WRITES opens no connection — and the rows really land', () => {
    boardListGET(req(), mockRes().res) // warm up
    const before = dbOpenStats()

    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const res = mockRes()
      boardCreatePOST(req({ body: { title: `w${i}`, teamId: 'team-write' } }), res.res)
      expect(res.statusCode()).toBe(200)
      ids.push((res.body() as { task: DbTask }).task.id)
    }
    boardCommentPOST(
      req({ params: { taskId: ids[0]! }, body: { body: 'a comment', authorType: 'system' } }),
      mockRes().res,
    )
    // A field patch, not a status transition — this case is about connection
    // count, and a state-machine rejection would make it fail for the wrong reason.
    boardUpdatePATCH(
      req({ params: { taskId: ids[0]! }, body: { title: 'renamed' } }),
      mockRes().res,
    )

    const after = dbOpenStats()
    expect(after.connectionsOpened - before.connectionsOpened).toBe(0)
    expect(after.schemaBootstraps - before.schemaBootstraps).toBe(0)

    // Guard against a no-op "pass": the writes must actually be in the DB.
    expect(listTasks(getDb(), { teamId: 'team-write' })).toHaveLength(3)
    expect(getComments(getDb(), ids[0]!)).toHaveLength(1)
  })

  it('an SSE stream teardown does NOT close the shared connection', () => {
    // The regression this exists for: the three SSE handlers used to own a
    // per-stream handle and close it on disconnect. On a shared connection that
    // would kill SQLite for the WHOLE server the first time a browser tab closed.
    const stream = mockSse()
    obsStreamGET(stream.req, stream.res)
    stream.close()

    expect(getDb().$client.open).toBe(true)
    const res = mockRes()
    boardListGET(req(), res.res)
    expect(res.statusCode()).toBe(200)
  })

  it('resetDb() genuinely evicts the memo (so the cases above are not stale)', () => {
    getDb()
    resetDb()

    const before = dbOpenStats()
    getDb()
    expect(dbOpenStats().connectionsOpened - before.connectionsOpened).toBe(1)
  })
})

// ─── Source guard ────────────────────────────────────────────────────────────

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('repo root (pnpm-workspace.yaml) not found')
}

/** Every non-test `.ts` under apps/web/server, as [posix repo-relative path, source]. */
function serverSources(): Array<[string, string]> {
  const root = repoRoot()
  const out: Array<[string, string]> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.ts')) {
        // Posix-normalised so the expectations below read the same on Windows.
        out.push([path.relative(root, full).split(path.sep).join('/'), readFileSync(full, 'utf8')])
      }
    }
  }
  walk(path.join(root, 'apps', 'web', 'server'))
  return out
}

/** `file:line` for every line matching `needle`, so a failure is actionable. */
function hits(needle: string): string[] {
  const found: string[] = []
  for (const [rel, src] of serverSources()) {
    src.split('\n').forEach((line, i) => {
      if (line.includes(needle)) found.push(`${rel}:${i + 1}`)
    })
  }
  return found
}

/** The distinct files containing `needle`. */
function filesWith(needle: string): string[] {
  return [...new Set(hits(needle).map((h) => h.slice(0, h.lastIndexOf(':'))))].sort()
}

describe('the shared connection — no server source opens its own handle', () => {
  it('walks a non-trivial number of files (the walker itself is not silently empty)', () => {
    expect(serverSources().length).toBeGreaterThan(50)
  })

  it('no server source calls createDb — every read/write goes through getDb()', () => {
    // Deliberately covers the paths no unit test drives: the board sweep and
    // approval-reaper intervals, the MCP supervisor, worktrees GC, the boot probe.
    // `hits` (not `filesWith`) so a failure names the exact line to fix.
    expect(hits('createDb(')).toEqual([])
  })

  it('openDb and ensureSchema are called from lib/db.ts and nowhere else', () => {
    expect(filesWith('openDb(')).toEqual(['apps/web/server/lib/db.ts'])
    expect(filesWith('ensureSchema(')).toEqual(['apps/web/server/lib/db.ts'])
  })

  it('no server source closes a handle — closeDb/resetDb in lib/db.ts are the only closers', () => {
    // The SSE-stream failure mode from the other direction: a `$client.close()`
    // anywhere else poisons the memo for the rest of the process.
    expect(filesWith('$client.close(')).toEqual(['apps/web/server/lib/db.ts'])
  })
})
