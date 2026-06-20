// Unified Memory Tiering: the shared Memory MCP server's per-run scope
// binding + scrub-on-write, plus the scoped attach-URL helpers. The headline is
// CROSS-RUNTIME SHARED RECALL — a fact saved by one runtime's bound session is
// recalled by a different runtime's session on the SAME team (over the same DB),
// and is invisible to another team. Driven over the in-memory MCP transport (no
// subprocess / network), each Client standing in for a different runtime's attach.

import { createDb, SqliteMemoryStore, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { buildAttachConfig, mcpHttpUrl } from '../config'
import { createMemoryServer } from '../memory/server'
import { callText, connectInMemory } from '../testing'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

async function search(boundScope: Record<string, string>, query: string): Promise<unknown[]> {
  const client = await connectInMemory(createMemoryServer(db, null, { boundScope }))
  const res = await callText(client, 'memory_search', { query, mode: 'fts' })
  return JSON.parse(res.text) as unknown[]
}

describe('Memory MCP — per-run scope binding', () => {
  it('HEADLINE: a team fact saved by one runtime is recalled by a different runtime on the same team', async () => {
    // Runtime 1 (e.g. Claude Code), bound to team-A / agent-1, saves a team fact.
    const writer = await connectInMemory(
      createMemoryServer(db, null, { boundScope: { teamId: 'team-A', agentId: 'agent-1' } }),
    )
    const saved = JSON.parse(
      (
        await callText(writer, 'memory_save', {
          title: 'Stripe',
          content: 'payments go through Stripe checkout',
        })
      ).text,
    ) as { fact: { scopeTeamId: string | null; scopeAgentId: string | null } }
    // Saved team-shared: team tag set, agent tag NULL (visible to every teammate).
    expect(saved.fact.scopeTeamId).toBe('team-A')
    expect(saved.fact.scopeAgentId).toBeNull()

    // Runtime 2 (e.g. Hermes), a DIFFERENT agent on the SAME team, recalls it.
    const sameTeam = await search({ teamId: 'team-A', agentId: 'agent-2' }, 'payments')
    expect(sameTeam.length).toBeGreaterThan(0)

    // A different team does NOT see it.
    const otherTeam = await search({ teamId: 'team-B', agentId: 'agent-9' }, 'payments')
    expect(otherTeam.length).toBe(0)
  })

  it('binds scope authoritatively — the model cannot mis-tag (or widen) a save', async () => {
    const writer = await connectInMemory(
      createMemoryServer(db, null, { boundScope: { teamId: 'team-A', agentId: 'agent-1' } }),
    )
    const saved = JSON.parse(
      (
        await callText(writer, 'memory_save', {
          title: 'X',
          content: 'y',
          scopeTeamId: 'team-EVIL', // model-supplied scope is ignored
          scopeAgentId: 'agent-EVIL',
        })
      ).text,
    ) as { fact: { scopeTeamId: string | null; scopeAgentId: string | null } }
    expect(saved.fact.scopeTeamId).toBe('team-A')
    expect(saved.fact.scopeAgentId).toBeNull()
  })

  it('unbound (no boundScope) preserves legacy behavior — the model args are used', async () => {
    const writer = await connectInMemory(createMemoryServer(db, null))
    const saved = JSON.parse(
      (await callText(writer, 'memory_save', { title: 'X', content: 'y', scopeTeamId: 'team-Z' }))
        .text,
    ) as { fact: { scopeTeamId: string | null } }
    expect(saved.fact.scopeTeamId).toBe('team-Z')
  })
})

describe('Memory MCP — scrub on write', () => {
  it('redacts a secret embedded in a saved fact (never stored, never searchable)', async () => {
    const writer = await connectInMemory(createMemoryServer(db, null))
    const secret = 'sk-abcdef1234567890XYZ'
    const saved = JSON.parse(
      (
        await callText(writer, 'memory_save', {
          title: 'Prod config',
          content: `the api key is ${secret} keep it safe`,
        })
      ).text,
    ) as { fact: { content: string } }
    expect(saved.fact.content).not.toContain(secret)
    expect(saved.fact.content).toContain('[REDACTED]')

    const found = JSON.parse(
      (await callText(writer, 'memory_search', { query: 'config', mode: 'fts' })).text,
    ) as Array<{
      content: string
    }>
    expect(found.length).toBeGreaterThan(0)
    expect(JSON.stringify(found)).not.toContain(secret)
  })

  it('declines to save a fact whose content was ENTIRELY a secret', async () => {
    const writer = await connectInMemory(createMemoryServer(db, null))
    const res = await callText(writer, 'memory_save', {
      title: 'Token',
      content: 'sk-abcdefghijklmnopqrstuv',
    })
    expect(res.isError).toBe(true)
    expect(res.text.toLowerCase()).toContain('redacted')
    const browsed = JSON.parse((await callText(writer, 'memory_browse', {})).text) as unknown[]
    expect(browsed.length).toBe(0)
  })

  it('declines to save a PROCEDURE whose content was ENTIRELY a secret (no useless [REDACTED] row)', async () => {
    const writer = await connectInMemory(createMemoryServer(db, null))
    const res = await callText(writer, 'memory_save', {
      procedureName: 'deploy',
      content: 'sk-abcdefghijklmnopqrstuv',
    })
    expect(res.isError).toBe(true)
    expect(res.text.toLowerCase()).toContain('redacted')
    // Nothing persisted — the all-secret guard now precedes the procedure branch,
    // so an all-secret procedure no longer stores a useless versioned [REDACTED].
    expect((await new SqliteMemoryStore(db).listProcedures()).length).toBe(0)
  })
})

describe('scoped attach URL helpers', () => {
  it('mcpHttpUrl appends scope to the Memory URL only', () => {
    expect(mcpHttpUrl('http://h:1', 'tasks', { teamId: 'T', agentId: 'A' })).toBe(
      'http://h:1/api/mcp/tasks',
    )
    expect(mcpHttpUrl('http://h:1', 'tools', { teamId: 'T' })).toBe('http://h:1/api/mcp/tools')
    const mem = mcpHttpUrl('http://h:1', 'memory', { teamId: 'T', agentId: 'A' })
    expect(mem.startsWith('http://h:1/api/mcp/memory?')).toBe(true)
    expect(mem).toContain('scopeTeamId=T')
    expect(mem).toContain('scopeAgentId=A')
    // No scope ⇒ bare URL.
    expect(mcpHttpUrl('http://h:1', 'memory')).toBe('http://h:1/api/mcp/memory')
  })

  it('buildAttachConfig carries the run scope onto the Memory server URL', () => {
    const cfg = buildAttachConfig({
      runtime: 'claude-code',
      server: 'memory',
      transport: 'http',
      httpBaseUrl: 'http://h:1',
      scope: { teamId: 'T' },
    })
    expect(JSON.stringify(cfg.structured)).toContain('scopeTeamId=T')
    // Tasks stays bare even with a scope present.
    const tasks = buildAttachConfig({
      runtime: 'claude-code',
      server: 'tasks',
      transport: 'http',
      httpBaseUrl: 'http://h:1',
      scope: { teamId: 'T' },
    })
    expect(JSON.stringify(tasks.structured)).not.toContain('scopeTeamId')
  })
})
