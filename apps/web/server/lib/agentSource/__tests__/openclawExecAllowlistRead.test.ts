// Reading someone else's permissions database without changing it, and without
// ever inventing an empty list.
//
// The obvious way to read this, `exec.approvals.get`, is a WRITE: its handler is
// `respond(true, toExecApprovalsPayload(await ensureExecApprovalsSnapshot()))`,
// and on a document it cannot parse that call replaces it with a fail-closed
// default. Opening a permissions panel would be enough to destroy every agent's
// policy. So the list comes from the SQLite row, read-only.
//
// The property that matters most here is a refusal. "This Boo has no standing
// grants" is a safety claim, and the way to get it catastrophically wrong is to
// print it about a document that could not be read while the grants are still on
// disk and still being enforced. The row carries counts written at save time,
// which is what makes the two cases distinguishable at all.

import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readOpenClawExecAllowlist } from '../openclawExecAllowlistRead'

const GRANT = {
  id: 'a2583e84',
  pattern: '/bin/echo',
  argPattern: 'sha256:cwd-argv:v1:f76b60c1',
  source: 'allow-always',
  lastUsedAt: 1789273436004,
  lastResolvedPath: '/bin/echo',
}
const MARKER = { id: 'cd9cc459', pattern: '=node-command:769c1dbc', source: 'allow-always' }

const CREATE_TABLE = `create table if not exists exec_approvals_config (
  config_key TEXT NOT NULL PRIMARY KEY, raw_json TEXT NOT NULL, socket_path TEXT,
  has_socket_token INTEGER NOT NULL, default_security TEXT, default_ask TEXT,
  default_ask_fallback TEXT, auto_allow_skills INTEGER, agent_count INTEGER NOT NULL,
  allowlist_count INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL) strict`

const INSERT_ROW = `insert or replace into exec_approvals_config
  (config_key, raw_json, socket_path, has_socket_token, default_security, default_ask,
   default_ask_fallback, auto_allow_skills, agent_count, allowlist_count, updated_at_ms)
  values ('current', ?, '/tmp/s.sock', 1, null, null, null, 0, ?, ?, 1789273452082)`

let stateDir: string
let env: NodeJS.ProcessEnv

/** Stand up a copy of OpenClaw's real table shape, taken from the live schema. */
function writeStore(rawJson: string, counts = { agents: 1, allowlist: 2 }) {
  const dbPath = path.join(stateDir, 'state', 'openclaw.sqlite')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  try {
    db.prepare(CREATE_TABLE).run()
    db.prepare(INSERT_ROW).run(rawJson, counts.agents, counts.allowlist)
  } finally {
    db.close()
  }
}

const doc = (agents: Record<string, unknown>, defaults: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    socket: { path: '/tmp/s.sock', token: 'SUPER_SECRET_TOKEN' },
    defaults,
    agents,
  })

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-allowlist-'))
  env = { OPENCLAW_STATE_DIR: stateDir }
})
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true }).catch(() => {})
})

describe('readOpenClawExecAllowlist', () => {
  it("reads a Boo's own grants and classifies each row", () => {
    writeStore(doc({ boo: { security: 'allowlist', ask: 'on-miss', allowlist: [GRANT, MARKER] } }))
    const res = readOpenClawExecAllowlist('boo', env)
    expect(res.state).toBe('ok')
    if (res.state !== 'ok') return
    expect(res.snapshot.entries.map((e) => e.classification)).toEqual([
      'bound-grant',
      'node-marker',
    ])
    expect(res.snapshot.storedAsk).toBe('on-miss')
    expect(res.snapshot.entries[0]?.lastResolvedPath).toBe('/bin/echo')
  })

  it('NEVER reports an unreadable document as an empty one', () => {
    // The whole reason this reads the row rather than calling the RPC. The counts
    // were written by the last good save, so a parse failure beside a non-zero
    // count is provably "cannot read" and not "nothing configured".
    writeStore('{ this is not json', { agents: 3, allowlist: 7 })
    const res = readOpenClawExecAllowlist('boo', env)
    expect(res.state).toBe('unreadable')
    if (res.state !== 'unreadable') return
    expect(res.knownAllowlistCount).toBe(7)
    expect(res.knownAgentCount).toBe(3)
  })

  it('reports a document that is valid JSON but not an object as unreadable', () => {
    writeStore('"a string"')
    expect(readOpenClawExecAllowlist('boo', env).state).toBe('unreadable')
  })

  it('distinguishes no document at all from an unreadable one', () => {
    // Nothing has ever been configured, fleet-wide. That IS an honest empty.
    expect(readOpenClawExecAllowlist('boo', env)).toEqual({ state: 'absent' })
  })

  it('reports a Boo with no bucket as genuinely empty', () => {
    writeStore(doc({ 'other-boo': { allowlist: [GRANT] } }))
    const res = readOpenClawExecAllowlist('boo', env)
    expect(res.state).toBe('ok')
    if (res.state !== 'ok') return
    expect(res.snapshot.entries).toEqual([])
    expect(res.snapshot.storedAsk).toBeNull()
  })

  it('never returns the socket token, which is an IPC credential', () => {
    writeStore(doc({ boo: { allowlist: [GRANT] } }))
    const res = readOpenClawExecAllowlist('boo', env)
    expect(JSON.stringify(res)).not.toContain('SUPER_SECRET_TOKEN')
  })

  it("keeps wildcard rows separate from the Boo's own", () => {
    // They are live for this Boo, since enforcement unions them ahead of the
    // agent bucket, but they are not this Boo's to revoke.
    writeStore(
      doc({ boo: { allowlist: [GRANT] }, '*': { allowlist: [{ pattern: '/usr/bin/git' }] } }),
    )
    const res = readOpenClawExecAllowlist('boo', env)
    if (res.state !== 'ok') throw new Error('expected ok')
    expect(res.snapshot.entries).toHaveLength(1)
    expect(res.snapshot.wildcard.map((e) => e.pattern)).toEqual(['/usr/bin/git'])
    expect(res.snapshot.wildcard[0]?.bucket).toBe('wildcard')
  })

  it('flags a row that also exists in the wildcard bucket', () => {
    // Revoking this from the agent bucket would verify clean and leave the
    // command running, so the caller has to know before it offers the button.
    writeStore(doc({ boo: { allowlist: [GRANT] }, '*': { allowlist: [GRANT] } }))
    const res = readOpenClawExecAllowlist('boo', env)
    if (res.state !== 'ok') throw new Error('expected ok')
    expect(res.snapshot.duplicatedInWildcard).toHaveLength(1)
  })

  it('surfaces the document defaults an absent agent field falls through to', () => {
    // Precedence is agent, then wildcard, then defaults. A panel showing only the
    // agent's own fields would label the list with a posture not in force.
    writeStore(doc({ boo: { allowlist: [] } }, { security: 'allowlist', ask: 'always' }))
    const res = readOpenClawExecAllowlist('boo', env)
    if (res.state !== 'ok') throw new Error('expected ok')
    expect(res.snapshot.storedAsk).toBeNull()
    expect(res.snapshot.defaultAsk).toBe('always')
  })

  it('skips a malformed row without discarding the readable ones', () => {
    writeStore(doc({ boo: { allowlist: [GRANT, null, { noPattern: true }, MARKER] } }))
    const res = readOpenClawExecAllowlist('boo', env)
    if (res.state !== 'ok') throw new Error('expected ok')
    expect(res.snapshot.entries.map((e) => e.pattern)).toEqual([GRANT.pattern, MARKER.pattern])
  })
})
