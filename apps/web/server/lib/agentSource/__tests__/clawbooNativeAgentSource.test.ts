// ClawbooNativeAgentSource — the AgentSource contract scenarios (create→get→
// update→archive round-trip, file round-trip, events on mutations) replicated
// against the REAL source + a sandboxed SQLite, plus the native specifics:
// AgentConfig KV (zod-valid), the budget row minted from budgetUsd, the archive
// sweep, source scoping, and session rows.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { DEFAULT_AGENT_CONFIG, NATIVE_PROVIDER_ENV_VARS } from '@clawboo/adapter-native'
import { agents, getBudget, getSetting, type ClawbooDb } from '@clawboo/db'

import { getDb, resetDb } from '../../db'
import { adapterFactoryFor } from '../../runtimes'
import type { RuntimeRunContext } from '../../runtimes/types'
import {
  loadAgentConfig,
  loadAgentConfigOrDefault,
  nativeConfigKey,
  nativeFileKey,
} from '../../runtimes/native/agentConfigStore'
import { upsertNativeSessionRow } from '../../runtimes/native/sessionStore'
import { ClawbooNativeAgentSource } from '../clawbooNativeAgentSource'

describe('ClawbooNativeAgentSource (AgentSource contract + native specifics)', () => {
  let home: string
  let stateDir: string
  let prevHome: string | undefined
  let prevState: string | undefined
  let source: ClawbooNativeAgentSource
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-source-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    // OPENCLAW_STATE_DIR short-circuits the state-dir resolution BEFORE the
    // sandboxed HOME, so an exported one would let the developer's real
    // ~/.openclaw/.env satisfy a provider-key lookup that must find nothing here.
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-source-st-'))
    prevHome = process.env['HOME']
    prevState = process.env['OPENCLAW_STATE_DIR']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    source = new ClawbooNativeAgentSource({ getDb })
    db = getDb()
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    // Drop the process-wide memo and this fixture's own handle before the
    // sandbox is removed — otherwise each test leaves a live SQLite handle
    // behind (and Windows refuses to rm a dir that still holds an open file).
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevState === undefined) delete process.env['OPENCLAW_STATE_DIR']
    else process.env['OPENCLAW_STATE_DIR'] = prevState
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(stateDir, { recursive: true, force: true }).catch(() => {})
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
      // The record surfaces the AgentConfig's primaryModel so the fleet + agent-detail
      // model selector can show/persist a native agent's chosen model.
      model: 'claude-haiku-4-5',
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

  it('auto-resolves the provider from the connected key when execConfig omits one (modelTier stripped)', async () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
      OLLAMA_BASE_URL: process.env['OLLAMA_BASE_URL'],
    }
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    delete process.env['OLLAMA_BASE_URL']
    process.env['OPENAI_API_KEY'] = 'sk-openai-test'
    try {
      const created = await source.createAgent({
        name: 'Auto',
        execConfig: {
          systemPrompt: 'hi',
          modelTier: 'leader',
          tools: { memory: true, tools: true, tasks: 'read', teamchat: true },
        },
      })
      const cfg = loadAgentConfig(db, created.id)
      expect(cfg?.primaryProvider).toBe('openai')
      expect(cfg?.primaryModel).toBe('gpt-5.4') // MODEL_DEFAULTS.openai.leader
      expect(cfg?.envVar).toBe('OPENAI_API_KEY')
      expect(cfg?.tools.tasks).toBe('read')
      // `modelTier` is a non-schema hint — stripped from BOTH the stored config
      // and the row's execConfig carrier.
      expect(cfg && 'modelTier' in (cfg as unknown as Record<string, unknown>)).toBe(false)
      const rowExec = created.execConfig as Record<string, unknown> | null
      expect(rowExec && 'modelTier' in rowExec).toBe(false)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('honors an explicit provider (the onboarding seed path is unchanged)', async () => {
    const created = await source.createAgent({
      name: 'Explicit',
      execConfig: {
        primaryProvider: 'anthropic',
        primaryModel: 'claude-haiku-4-5',
        envVar: 'ANTHROPIC_API_KEY',
        systemPrompt: 'x',
      },
    })
    const cfg = loadAgentConfig(db, created.id)
    expect(cfg?.primaryProvider).toBe('anthropic')
    expect(cfg?.primaryModel).toBe('claude-haiku-4-5')
  })

  it('file round-trip through the KV namespace (missing read is empty)', async () => {
    const a = await source.createAgent({ name: 'Files Boo' })
    // Every file EXCEPT SOUL.md reads back empty when never written.
    expect(await source.readFile(a.id, 'IDENTITY.md')).toBe('')
    await source.writeFile(a.id, 'IDENTITY.md', '# Me')
    expect(await source.readFile(a.id, 'IDENTITY.md')).toBe('# Me')
  })

  it('SOUL.md IS the systemPrompt: it mirrors on read and re-derives on write', async () => {
    const a = await source.createAgent({ name: 'Soul Boo' })
    const config = loadAgentConfigOrDefault(db, a.id)

    // An unwritten SOUL.md shows what the agent is ACTUALLY running rather
    // than a blank box. Every server-seeded native agent is in this state.
    expect(await source.readFile(a.id, 'SOUL.md')).toBe(config.systemPrompt)

    // Writing it re-derives the systemPrompt the run path reads. Before this
    // wiring the bytes were stored and nothing consumed them.
    await source.writeFile(a.id, 'SOUL.md', '# Soulful')
    expect(await source.readFile(a.id, 'SOUL.md')).toBe('# Soulful')
    expect(loadAgentConfigOrDefault(db, a.id).systemPrompt).toBe('# Soulful')

    // Emptying it falls back to the shipped default rather than leaving the
    // agent with no system prompt at all.
    await source.writeFile(a.id, 'SOUL.md', '   ')
    expect(loadAgentConfigOrDefault(db, a.id).systemPrompt).toBe(DEFAULT_AGENT_CONFIG.systemPrompt)
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

  // ── Multi-tenant seam (SaaS-readiness) ──────────────────────────────────────

  it('carries an explicit tenantId onto the row, the AgentConfig, and the budget', async () => {
    const a = await source.createAgent({
      name: 'Tenant Boo',
      tenantId: 'acme',
      execConfig: { budgetUsd: 2 },
    })
    // The returned record AND the raw agents row both carry the tenant.
    expect(a.tenantId).toBe('acme')
    const row = db
      .select({ tenantId: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, a.id))
      .get()
    expect(row?.tenantId).toBe('acme')
    // The co-written AgentConfig blob + the minted budget row carry it too.
    expect(loadAgentConfig(db, a.id)?.tenantId).toBe('acme')
    expect(getBudget(db, 'agent', a.id)?.tenantId).toBe('acme')
  })

  it('defaults tenantId to null when unspecified (byte-identical single-tenant no-op)', async () => {
    const a = await source.createAgent({ name: 'No Tenant Boo', execConfig: { budgetUsd: 2 } })
    expect(a.tenantId).toBeNull()
    const row = db
      .select({ tenantId: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, a.id))
      .get()
    expect(row?.tenantId).toBeNull()
    expect(loadAgentConfig(db, a.id)?.tenantId).toBeNull()
    expect(getBudget(db, 'agent', a.id)?.tenantId).toBeNull()
  })
})

describe('providerReady: per-agent key readiness (vs the permissive runtime health)', () => {
  let home: string
  let stateDir: string
  let prevHome: string | undefined
  let prevState: string | undefined
  const savedKeys: Record<string, string | undefined> = {}
  let source: ClawbooNativeAgentSource

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-ready-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-ready-st-'))
    prevHome = process.env['HOME']
    prevState = process.env['OPENCLAW_STATE_DIR']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    // Empty vault + no OpenClaw .env (sandboxed above) + a cleared process env:
    // "connected" is exactly what THIS test sets, never a developer's ambient key.
    for (const k of ['OLLAMA_BASE_URL', ...NATIVE_PROVIDER_ENV_VARS]) {
      savedKeys[k] = process.env[k]
      delete process.env[k]
    }
    source = new ClawbooNativeAgentSource({ getDb })
  })
  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevState === undefined) delete process.env['OPENCLAW_STATE_DIR']
    else process.env['OPENCLAW_STATE_DIR'] = prevState
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(stateDir, { recursive: true, force: true }).catch(() => {})
  })

  it('is false with no key, true once the key appears, and always true for ollama', async () => {
    const created = await source.createAgent({
      name: 'Anthropic Agent',
      teamId: null,
      execConfig: {
        primaryProvider: 'anthropic',
        primaryModel: 'claude-haiku-4-5',
        envVar: 'ANTHROPIC_API_KEY',
      },
    })
    expect(created.providerReady).toBe(false)

    process.env['ANTHROPIC_API_KEY'] = 'sk-test'
    const listed = await source.listAgents()
    expect(listed.find((a) => a.id === created.id)?.providerReady).toBe(true)

    const local = await source.createAgent({
      name: 'Local Agent',
      teamId: null,
      execConfig: {
        primaryProvider: 'ollama',
        primaryModel: 'llama3.2',
        envVar: 'OLLAMA_BASE_URL',
      },
    })
    expect(local.providerReady).toBe(true)
  })

  it('REGRESSION: an agent parked on a disconnected provider reads not-ready while runtime health stays green', async () => {
    // The audited failure shape: OpenRouter is the only connected provider, the
    // agent is configured for Anthropic. Runtime health passes on ANY key
    // (deliberate, pinned in nativeHealth.test.ts), so before providerReady the
    // dashboard showed green everywhere while every run failed with
    // "no provider key available".
    process.env['OPENROUTER_API_KEY'] = 'or-test-key'
    const agent = await source.createAgent({
      name: 'Parked Agent',
      teamId: null,
      execConfig: {
        primaryProvider: 'anthropic',
        primaryModel: 'claude-haiku-4-5',
        envVar: 'ANTHROPIC_API_KEY',
      },
    })

    const health = await adapterFactoryFor('clawboo-native')({} as RuntimeRunContext).health()
    expect(health.ok).toBe(true)
    expect(agent.providerReady).toBe(false)
  })
})
