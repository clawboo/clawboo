// Reading OpenClaw's tab store, and refusing to guess when we no longer understand it.
//
// This module exists because clawboo cannot tell which OpenClaw agent is calling
// its MCP server, so it reads the agent's identity off the tab instead of
// inferring it. That makes ONE property load-bearing above all others: when the
// data stops meaning what we think it means, we must show nothing rather than
// show one Boo's browsing under another Boo's name.
//
// The tests below are mostly about that refusal. The happy path is one test; the
// rest are the ways a foreign schema can drift underneath us.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  newestTabForSourceAgent,
  readOpenClawTabs,
  sourceAgentIdFromSessionKey,
} from '../openclawSessionTabs'

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A record shaped exactly like the live one, hashed the way OpenClaw hashes it. */
function tabRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    sessionKey: 'agent:browser-test-boo:main',
    nativeTargetId: '8F405229FF900BE8FEB88122EADF07C1',
    profile: 'openclaw',
    profileFingerprint: 'sha256:aaa',
    browserInstanceFingerprint: 'sha256:bbb',
    interactionTargetKind: 'native',
    trackedAt: 1788811366358,
    lastUsedAt: 1788811368703,
    ...over,
  }
}

function keyFor(r: Record<string, unknown>): string {
  const parts = [
    r['sessionKey'],
    r['nativeTargetId'],
    r['profileFingerprint'],
    r['browserInstanceFingerprint'],
  ]
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}

/** A throwaway state dir shaped like ~/.openclaw, returned as an env override. */
function stateWith(rows: { key: string; value: unknown }[]): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-tabs-'))
  made.push(dir)
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  const db = new Database(path.join(dir, 'state', 'openclaw.sqlite'))
  db.prepare(
    `create table plugin_state_entries (
       plugin_id text, namespace text, entry_key text, value_json text,
       created_at integer, expires_at integer)`,
  ).run()
  const insert = db.prepare(
    `insert into plugin_state_entries values ('browser', 'browser.session-tabs', ?, ?, 0, null)`,
  )
  for (const r of rows) insert.run(r.key, JSON.stringify(r.value))
  db.close()
  return { OPENCLAW_STATE_DIR: dir }
}

describe('sourceAgentIdFromSessionKey', () => {
  it('reads the agent id out of every session-key shape', () => {
    // Three shapes exist on a live Gateway, and the third is why this cannot be a
    // plain three-way split: `mainKey` contains colons of its own.
    expect(sourceAgentIdFromSessionKey('agent:bug-fixer-boo:main')).toBe('bug-fixer-boo')
    expect(sourceAgentIdFromSessionKey('agent:main:team:b09ec092-aaaa')).toBe('main')
    expect(sourceAgentIdFromSessionKey('agent:x:dashboard:34d2ffa2-bbbb')).toBe('x')
  })

  it('returns null rather than guessing at an unfamiliar shape', () => {
    for (const bad of ['', 'main', 'agent:', 'agent::main', 'session:x:main', 'agent:x']) {
      expect(sourceAgentIdFromSessionKey(bad)).toBeNull()
    }
  })
})

describe('readOpenClawTabs', () => {
  it('reads a well-formed record', () => {
    const rec = tabRecord()
    const tabs = readOpenClawTabs(stateWith([{ key: keyFor(rec), value: rec }]))
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.sessionKey).toBe('agent:browser-test-boo:main')
    expect(tabs[0]?.targetId).toBe('8F405229FF900BE8FEB88122EADF07C1')
  })

  it('REFUSES a record whose key does not re-derive from its own fields', () => {
    // The safety property, and the reason this module can be coupled to another
    // product's private table at all. OpenClaw derives each row's key from the
    // row's contents and uses the recomputation as its own gate. If a future
    // version hashes different fields, our recomputation stops matching and we
    // show nothing — instead of confidently attributing a tab using fields that no
    // longer mean what we assume.
    const rec = tabRecord()
    const tabs = readOpenClawTabs(stateWith([{ key: 'sha256:not-the-real-hash', value: rec }]))
    expect(tabs).toHaveLength(0)
  })

  it('REFUSES a record whose session key was tampered with', () => {
    // The case the gate actually blocks: keep a valid-looking key, swap the owner.
    // Without the recomputation this would file one Boo's tab under another.
    const real = tabRecord()
    const swapped = { ...real, sessionKey: 'agent:some-other-boo:main' }
    const tabs = readOpenClawTabs(stateWith([{ key: keyFor(real), value: swapped }]))
    expect(tabs).toHaveLength(0)
  })

  it('survives rows it cannot parse at all', () => {
    const good = tabRecord()
    const env = stateWith([
      { key: 'sha256:x', value: 'not-an-object' },
      { key: keyFor(good), value: good },
    ])
    expect(readOpenClawTabs(env)).toHaveLength(1)
  })

  it('returns nothing when OpenClaw is not installed', () => {
    // A clawboo with no OpenClaw at all must not throw on every panel poll.
    expect(readOpenClawTabs({ OPENCLAW_STATE_DIR: '/nonexistent/clawboo-test' })).toEqual([])
  })
})

describe('newestTabForSourceAgent', () => {
  it("picks the most recently used of an agent's tabs", () => {
    // OpenClaw allows eight per session; "what is this Boo doing" means the last one.
    const older = tabRecord({ nativeTargetId: 'AAA', lastUsedAt: 1 })
    const newer = tabRecord({ nativeTargetId: 'BBB', lastUsedAt: 999 })
    const env = stateWith([
      { key: keyFor(older), value: older },
      { key: keyFor(newer), value: newer },
    ])
    expect(newestTabForSourceAgent('browser-test-boo', env)?.targetId).toBe('BBB')
  })

  it("does not hand one agent another agent's tab", () => {
    const theirs = tabRecord({ sessionKey: 'agent:other-boo:main' })
    const env = stateWith([{ key: keyFor(theirs), value: theirs }])
    expect(newestTabForSourceAgent('browser-test-boo', env)).toBeNull()
  })
})
