// ClawbooNativeAgentSource — the AgentSource contract scenarios (create→get→
// update→archive round-trip, file round-trip, events on mutations) replicated
// against the REAL source + a sandboxed SQLite, plus the native specifics:
// AgentConfig KV (zod-valid), the budget row minted from budgetUsd, the archive
// sweep, source scoping, and session rows.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createDb, getBudget, getSetting, type ClawbooDb } from '@clawboo/db'

import { getDbPath } from '../../db'
import {
  loadAgentConfig,
  nativeConfigKey,
  nativeFileKey,
} from '../../runtimes/native/agentConfigStore'
import { upsertNativeSessionRow } from '../../runtimes/native/sessionStore'
import { ClawbooNativeAgentSource } from '../clawbooNativeAgentSource'

describe('ClawbooNativeAgentSource (AgentSource contract + native specifics)', () => {
  let home: string
  let prevHome: string | undefined
  let source: ClawbooNativeAgentSource
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-source-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    source = new ClawbooNativeAgentSource({ getDbPath })
    db = createDb(getDbPath())
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('round-trips create → get → update → archive (the contract spine)', async () => {
    const created = await source.createAgent({
      name: 'Native Lead',
      teamId: null,
      execConfig: { primaryProvider: 'anthropic', primaryModel: 'claude-haiku-4-5', maxTurns: 8 },
    })
    expect(created).toMatchObject({
      sourceId: 'clawboo-native',
      runtime: 'clawboo-native',
      displayName: 'Native Lead',
      status: 'idle',
      participantKind: 'agent',
      tenantId: null,
    })
    expect(created.sessionKey).toBe(`agent:${created.id}:native`)

    const fetched = await source.getAgent(created.id)
    expect(fetched).toEqual(created)

    const updated = await source.updateAgent(created.id, {
      displayName: 'Native Lead v2',
      status: 'running',
    })
    expect(updated).toMatchObject({ displayName: 'Native Lead v2', status: 'running' })

    await source.archiveAgent(created.id)
    expect(await source.getAgent(created.id)).toBeNull()
  })

  it('file round-trip through the KV namespace (missing read is empty)', async () => {
    const a = await source.createAgent({ name: 'Files Boo' })
    expect(await source.readFile(a.id, 'SOUL.md')).toBe('')
    await source.writeFile(a.id, 'SOUL.md', '# Soulful')
    expect(await source.readFile(a.id, 'SOUL.md')).toBe('# Soulful')
  })

  it('events fire on mutations', async () => {
    const iterator = source.events()[Symbol.asyncIterator]()
    const created = await source.createAgent({ name: 'Eventful Boo' })
    expect((await iterator.next()).value).toMatchObject({ kind: 'agent-upserted' })
    await source.updateAgent(created.id, { status: 'sleeping' })
    expect((await iterator.next()).value).toMatchObject({ kind: 'agent-upserted' })
    await source.archiveAgent(created.id)
    expect((await iterator.next()).value).toMatchObject({
      kind: 'agent-archived',
      agentId: created.id,
    })
    await iterator.return?.()
  })

  it('createAgent persists a zod-valid AgentConfig (SOUL.md doubles as the systemPrompt fallback)', async () => {
    const a = await source.createAgent({
      name: 'Configured Boo',
      execConfig: {
        primaryProvider: 'openrouter',
        primaryModel: 'openai/gpt-4o-mini',
        envVar: 'OPENROUTER_API_KEY',
      },
      files: { 'SOUL.md': 'You are the configured boo.' },
    })
    const config = loadAgentConfig(db, a.id)
    expect(config).toMatchObject({
      id: a.id,
      name: 'Configured Boo',
      primaryProvider: 'openrouter',
      primaryModel: 'openai/gpt-4o-mini',
      envVar: 'OPENROUTER_API_KEY',
      systemPrompt: 'You are the configured boo.',
      tenantId: null,
    })
  })

  it('a budgetUsd in the config mints an agent-scope hard-cap budget row', async () => {
    const a = await source.createAgent({ name: 'Budgeted Boo', execConfig: { budgetUsd: 1.5 } })
    const budget = getBudget(db, 'agent', a.id)
    expect(budget).toMatchObject({
      scope: 'agent',
      scopeId: a.id,
      limitUsdCents: 150,
      mode: 'cap',
      status: 'active',
    })
  })

  it('an execConfig patch re-validates + rewrites the stored AgentConfig', async () => {
    const a = await source.createAgent({ name: 'Patch Boo' })
    await source.updateAgent(a.id, {
      execConfig: { primaryModel: 'claude-sonnet-4-6', maxTurns: 4 },
    })
    expect(loadAgentConfig(db, a.id)).toMatchObject({
      primaryModel: 'claude-sonnet-4-6',
      maxTurns: 4,
    })
  })

  it('archive sweeps the per-agent KV rows and session rows', async () => {
    const a = await source.createAgent({ name: 'Sweep Boo', files: { 'TOOLS.md': '- a-skill' } })
    upsertNativeSessionRow(db, { sessionId: 'native-sweep-1', agentId: a.id })
    expect(getSetting(db, nativeConfigKey(a.id))).not.toBeNull()
    expect(getSetting(db, nativeFileKey(a.id, 'TOOLS.md'))).not.toBeNull()

    await source.archiveAgent(a.id)
    expect(getSetting(db, nativeConfigKey(a.id))).toBeNull()
    expect(getSetting(db, nativeFileKey(a.id, 'TOOLS.md'))).toBeNull()
    expect(await source.listSessions(a.id)).toEqual([])
  })

  it('is scoped to its own rows — never returns or claims a foreign source agent', async () => {
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'oc-1',
        name: 'Gateway Boo',
        gatewayId: 'oc-1',
        sourceId: 'openclaw',
        sourceAgentId: 'oc-1',
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    await source.createAgent({ name: 'Native Boo' })

    const list = await source.listAgents()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ sourceId: 'clawboo-native' })
    expect(await source.getAgent('oc-1')).toBeNull()
  })

  it('listSessions returns the harness-upserted rows (never throws offline)', async () => {
    const a = await source.createAgent({ name: 'Session Boo' })
    expect(await source.listSessions(a.id)).toEqual([])
    upsertNativeSessionRow(db, { sessionId: 'native-list-1', agentId: a.id })
    const rows = await source.listSessions(a.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sourceId: 'clawboo-native',
      sourceSessionId: 'native-list-1',
      agentId: a.id,
    })
  })

  it('health is always connected and sync is a zero-result no-op', async () => {
    expect(await source.health()).toMatchObject({ ok: true, connection: 'connected' })
    expect(await source.sync()).toMatchObject({ upserted: 0, archived: 0 })
  })
})
