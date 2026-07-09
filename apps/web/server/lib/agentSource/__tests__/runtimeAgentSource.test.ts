// RuntimeAgentSource — the generic coding-runtime record source (claude-code /
// codex / hermes). Covers the AgentSource contract spine (create→get→list→update
// →archive), source scoping, the file-KV round-trip + prefix-sweep on archive,
// and that the row carries the runtime as both sourceId + runtime.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, getSetting, type ClawbooDb } from '@clawboo/db'

import { getDbPath } from '../../db'
import { runtimeAgentFileKey } from '../runtimeAgentFileStore'
import { RuntimeAgentSource } from '../runtimeAgentSource'

describe('RuntimeAgentSource (generic coding-runtime record source)', () => {
  let home: string
  let prevHome: string | undefined
  let source: RuntimeAgentSource
  let other: RuntimeAgentSource
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-runtime-source-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    source = new RuntimeAgentSource({ getDbPath, runtimeId: 'claude-code' })
    other = new RuntimeAgentSource({ getDbPath, runtimeId: 'hermes' })
    db = createDb(getDbPath())
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('round-trips create → get → update → archive; row carries the runtime', async () => {
    const created = await source.createAgent({
      name: 'Coder',
      teamId: null,
      execConfig: { participantKind: 'agent' },
    })
    expect(created).toMatchObject({
      sourceId: 'claude-code',
      runtime: 'claude-code',
      displayName: 'Coder',
      status: 'idle',
      participantKind: 'agent',
    })
    expect(created.id.startsWith('claude-code-')).toBe(true)
    expect(created.sessionKey).toBe(`agent:${created.id}:claude-code`)

    expect(await source.getAgent(created.id)).toEqual(created)

    const updated = await source.updateAgent(created.id, { status: 'running' })
    expect(updated.status).toBe('running')

    await source.archiveAgent(created.id)
    expect(await source.getAgent(created.id)).toBeNull()
  })

  it('is source-scoped — a hermes source cannot see a claude-code agent', async () => {
    const cc = await source.createAgent({ name: 'CC' })
    expect(await other.getAgent(cc.id)).toBeNull()
    expect((await other.listAgents()).map((a) => a.id)).not.toContain(cc.id)
    expect((await source.listAgents()).map((a) => a.id)).toContain(cc.id)
  })

  it('file round-trip via the runtime-file KV; archive sweeps the prefix', async () => {
    const created = await source.createAgent({ name: 'Files', files: { 'SOUL.md': '# soul' } })
    // Files written at create time land in the runtime-file KV.
    expect(getSetting(db, runtimeAgentFileKey(created.id, 'SOUL.md'))).toBe('# soul')
    expect(await source.readFile(created.id, 'SOUL.md')).toBe('# soul')

    await source.writeFile(created.id, 'IDENTITY.md', '# id')
    expect(getSetting(db, runtimeAgentFileKey(created.id, 'IDENTITY.md'))).toBe('# id')
    // A missing file reads empty.
    expect(await source.readFile(created.id, 'TOOLS.md')).toBe('')
    // An unknown file name is rejected.
    await expect(source.writeFile(created.id, 'secrets.env' as never, 'x')).rejects.toThrow()

    await source.archiveAgent(created.id)
    // The prefix sweep removes ALL file-KV rows (incl. non-canonical names).
    expect(getSetting(db, runtimeAgentFileKey(created.id, 'SOUL.md'))).toBeNull()
    expect(getSetting(db, runtimeAgentFileKey(created.id, 'IDENTITY.md'))).toBeNull()
  })

  it('health is always connected; sync is a no-op', async () => {
    expect(await source.health()).toMatchObject({ ok: true, connection: 'connected' })
    expect(await source.sync()).toMatchObject({ upserted: 0, archived: 0 })
  })
})
