// Per-task resume pointers, as stored.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createTask,
  dropTask,
  getSetting,
  setSetting,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'

import { getDb, getDbPath, resetDb } from '../../db'
import {
  encodeTaskSessionPointer,
  nativeTeamSessionSettingKey,
  taskSessionSettingKey,
} from '../nativeTeamSession'
import {
  clearTaskSessionPointers,
  readTaskSessionPointer,
  sweepTaskSessionPointers,
  ticketHashOf,
} from '../taskSessionPointers'

let db: ClawbooDb
let home: string
let prevHome: string | undefined
let prevClawbooHome: string | undefined
beforeEach(async () => {
  // A database of its own: `getDb()` follows $HOME and CLAWBOO_HOME.
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-task-pointers-'))
  prevHome = process.env['HOME']
  prevClawbooHome = process.env['CLAWBOO_HOME']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  expect(getDbPath().startsWith(home)).toBe(true)
  db = getDb()
})
afterEach(async () => {
  resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevClawbooHome
  await rm(home, { recursive: true, force: true })
})

const pointer = (sessionId: string) =>
  encodeTaskSessionPointer({ sessionId, runtime: 'codex', ticketHash: 'h', seenAt: 1 })

describe('ticketHashOf', () => {
  it('changes when the title or the description changes, and only then', () => {
    const base = ticketHashOf({ title: 'Write the intro', description: 'Two paragraphs.' })
    expect(ticketHashOf({ title: 'Write the intro', description: 'Two paragraphs.' })).toBe(base)
    expect(ticketHashOf({ title: 'Write the outro', description: 'Two paragraphs.' })).not.toBe(
      base,
    )
    expect(ticketHashOf({ title: 'Write the intro', description: 'Three paragraphs.' })).not.toBe(
      base,
    )
    expect(ticketHashOf({ title: 'ab', description: 'c' })).not.toBe(
      ticketHashOf({ title: 'a', description: 'bc' }),
    )
    expect(ticketHashOf({ title: 'x', description: null })).toBe(
      ticketHashOf({ title: 'x', description: '' }),
    )
  })
})

describe('reading and clearing pointers', () => {
  it('reads an agent’s pointer for a task, and clears every agent’s pointer for it at once', () => {
    const t = createTask(db, { title: 'Fix parser', teamId: 'T' })
    const other = createTask(db, { title: 'Write docs', teamId: 'T' })
    setSetting(db, taskSessionSettingKey('a1', 'T', t.id), pointer('s-1'))
    setSetting(db, taskSessionSettingKey('a2', 'T', t.id), pointer('s-2'))
    setSetting(db, taskSessionSettingKey('a1', 'T', other.id), pointer('s-3'))
    setSetting(db, nativeTeamSessionSettingKey('a1', 'T'), 'leader-session')

    expect(readTaskSessionPointer(db, 'a1', 'T', t.id)?.sessionId).toBe('s-1')
    clearTaskSessionPointers(db, t.id)
    expect(readTaskSessionPointer(db, 'a1', 'T', t.id)).toBeNull()
    expect(readTaskSessionPointer(db, 'a2', 'T', t.id)).toBeNull()
    // Another task's pointer and the leader's own pointer are untouched.
    expect(readTaskSessionPointer(db, 'a1', 'T', other.id)?.sessionId).toBe('s-3')
    expect(getSetting(db, nativeTeamSessionSettingKey('a1', 'T'))).toBe('leader-session')
  })
})

describe('sweepTaskSessionPointers', () => {
  it('drops pointers to finished, cancelled, dropped or missing tasks and malformed values, and keeps the rest', () => {
    const live = createTask(db, { title: 'live', teamId: 'T' })
    const done = createTask(db, { title: 'done', teamId: 'T' })
    const cancelled = createTask(db, { title: 'cancelled', teamId: 'T' })
    const dropped = createTask(db, { title: 'dropped', teamId: 'T' })
    const malformed = createTask(db, { title: 'malformed', teamId: 'T' })
    updateStatus(db, done.id, 'in_progress')
    updateStatus(db, done.id, 'done')
    updateStatus(db, cancelled.id, 'cancelled')
    dropTask(db, dropped.id)
    setSetting(db, taskSessionSettingKey('a1', 'T', live.id), pointer('keep'))
    setSetting(db, taskSessionSettingKey('a1', 'T', done.id), pointer('x'))
    setSetting(db, taskSessionSettingKey('a1', 'T', cancelled.id), pointer('x'))
    setSetting(db, taskSessionSettingKey('a1', 'T', dropped.id), pointer('x'))
    setSetting(db, taskSessionSettingKey('a1', 'T', 'no-such-task'), pointer('x'))
    setSetting(db, taskSessionSettingKey('a1', 'T', malformed.id), '')

    expect(sweepTaskSessionPointers(db)).toBe(5)
    expect(readTaskSessionPointer(db, 'a1', 'T', live.id)?.sessionId).toBe('keep')
    expect(getSetting(db, taskSessionSettingKey('a1', 'T', done.id))).toBeNull()
    expect(getSetting(db, taskSessionSettingKey('a1', 'T', dropped.id))).toBeNull()
    expect(getSetting(db, taskSessionSettingKey('a1', 'T', malformed.id))).toBeNull()
    expect(sweepTaskSessionPointers(db)).toBe(0)
  })
})
