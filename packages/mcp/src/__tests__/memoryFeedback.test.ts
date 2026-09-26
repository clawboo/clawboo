// Memory feedback loop: the memory_feedback tool + provenance threading, driven
// over the in-memory MCP transport (contract-test style — a real Client, no
// subprocess). Covers the learning-status transitions (tentative → preferred on
// a second DISTINCT corroborator; contested on mixed signals), prefix citation,
// the invisible-fact refusal (same error as nonexistent — no cross-team
// existence oracle), and the bound-vs-unbound provenance asymmetry on saves.

import { createDb, type ClawbooDb, type LearningEntry, type MemoryOutcome } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { createMemoryServer, type MemoryServerOptions } from '../memory/server'
import { callText, connectInMemory } from '../testing'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

const connect = (opts?: MemoryServerOptions): Promise<Client> =>
  connectInMemory(createMemoryServer(db, null, opts))

interface SavedFact {
  fact: {
    id: string
    scopeTeamId: string | null
    scopeAgentId: string | null
    createdByAgentId: string | null
    createdByRuntime: string | null
    sourceTaskId: string | null
    sourceSessionKey: string | null
  }
}

async function saveFact(client: Client, title = 'Stripe', content = 'payments via Stripe') {
  const res = await callText(client, 'memory_save', { title, content })
  return (JSON.parse(res.text) as SavedFact).fact
}

interface FeedbackResult {
  recorded: MemoryOutcome
  learning: LearningEntry | null
}

async function feedback(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ res: { text: string; isError: boolean }; parsed: FeedbackResult | null }> {
  const res = await callText(client, 'memory_feedback', args)
  return { res, parsed: res.isError ? null : (JSON.parse(res.text) as FeedbackResult) }
}

describe('memory_feedback — learning transitions', () => {
  it('useful → tentative; same reporter again stays tentative; a second DISTINCT reporter → preferred', async () => {
    const writer = await connect({ boundScope: { teamId: 'team-A', agentId: 'agent-1' } })
    const fact = await saveFact(writer)

    const first = await feedback(writer, { factId: fact.id, outcome: 'useful' })
    expect(first.parsed?.learning?.status).toBe('tentative')
    expect(first.parsed?.learning?.usefulCount).toBe(1)

    // The SAME (agent, task) reporter collapses to one corroborator.
    const repeat = await feedback(writer, { factId: fact.id, outcome: 'useful' })
    expect(repeat.parsed?.learning?.status).toBe('tentative')
    expect(repeat.parsed?.learning?.usefulCount).toBe(1)

    const teammate = await connect({ boundScope: { teamId: 'team-A', agentId: 'agent-2' } })
    const second = await feedback(teammate, { factId: fact.id, outcome: 'useful' })
    expect(second.parsed?.learning?.status).toBe('preferred')
    expect(second.parsed?.learning?.usefulCount).toBe(2)
  })

  it('mixed signals → contested (dead_end after useful)', async () => {
    const writer = await connect({ boundScope: { teamId: 'team-A', agentId: 'agent-1' } })
    const fact = await saveFact(writer)
    await feedback(writer, { factId: fact.id, outcome: 'useful' })

    const teammate = await connect({ boundScope: { teamId: 'team-A', agentId: 'agent-2' } })
    const mixed = await feedback(teammate, { factId: fact.id, outcome: 'dead_end' })
    expect(mixed.parsed?.learning?.status).toBe('contested')
    expect(mixed.parsed?.learning?.negativeCount).toBe(1)
  })

  it('accepts an 8-char id prefix and resolves it to the full fact', async () => {
    const writer = await connect({ boundScope: { teamId: 'team-A', agentId: 'agent-1' } })
    const fact = await saveFact(writer)
    const byPrefix = await feedback(writer, { factId: fact.id.slice(0, 8), outcome: 'useful' })
    expect(byPrefix.res.isError).toBe(false)
    expect(byPrefix.parsed?.recorded.factId).toBe(fact.id)
  })

  it('records taskId/runtime provenance on the outcome from server-authored opts', async () => {
    const writer = await connect({
      boundScope: { teamId: 'team-A', agentId: 'agent-1' },
      provenance: { runtime: 'claude-code', taskId: 'task-9' },
    })
    const fact = await saveFact(writer)
    const { parsed } = await feedback(writer, { factId: fact.id, outcome: 'useful' })
    expect(parsed?.recorded.agentId).toBe('agent-1')
    expect(parsed?.recorded.teamId).toBe('team-A')
    expect(parsed?.recorded.taskId).toBe('task-9')
    expect(parsed?.recorded.runtime).toBe('claude-code')
  })
})

describe('memory_feedback — refusals', () => {
  it('refuses a scope-invisible fact with the SAME error as a nonexistent one (no existence oracle)', async () => {
    const writer = await connect({ boundScope: { teamId: 'team-A', agentId: 'agent-1' } })
    const fact = await saveFact(writer)

    const outsider = await connect({ boundScope: { teamId: 'team-B', agentId: 'agent-9' } })
    const invisible = await feedback(outsider, { factId: fact.id, outcome: 'useful' })
    const nonexistent = await feedback(outsider, {
      factId: '00000000-0000-0000-0000-000000000000',
      outcome: 'useful',
    })
    expect(invisible.res.isError).toBe(true)
    expect(nonexistent.res.isError).toBe(true)
    expect(invisible.res.text).toBe(nonexistent.res.text)
  })

  it('refuses corrected without a note', async () => {
    const writer = await connect({ boundScope: { teamId: 'team-A', agentId: 'agent-1' } })
    const fact = await saveFact(writer)
    const missing = await feedback(writer, { factId: fact.id, outcome: 'corrected' })
    expect(missing.res.isError).toBe(true)
    expect(missing.res.text).toContain('note')
    // Whitespace-only note is not a note.
    const blank = await feedback(writer, { factId: fact.id, outcome: 'corrected', note: '   ' })
    expect(blank.res.isError).toBe(true)
  })
})

describe('memory_save — provenance threading', () => {
  it('a bound save records provenance while scope_agent_id stays null (team-shared recall intact)', async () => {
    const writer = await connect({
      boundScope: { teamId: 'team-A', agentId: 'agent-1' },
      provenance: { runtime: 'claude-code', taskId: 'task-9', sessionKey: 'sess-1' },
    })
    const fact = await saveFact(writer)
    expect(fact.scopeTeamId).toBe('team-A')
    expect(fact.scopeAgentId).toBeNull() // visibility stays team-shared
    expect(fact.createdByAgentId).toBe('agent-1') // …but authorship is legible
    expect(fact.createdByRuntime).toBe('claude-code')
    expect(fact.sourceTaskId).toBe('task-9')
    expect(fact.sourceSessionKey).toBe('sess-1')
  })

  it('a bound PROCEDURE save records the same provenance', async () => {
    const writer = await connect({
      boundScope: { teamId: 'team-A', agentId: 'agent-1' },
      provenance: { runtime: 'claude-code', taskId: 'task-9' },
    })
    const res = await callText(writer, 'memory_save', {
      procedureName: 'deploy',
      content: 'run the deploy script',
    })
    const proc = (
      JSON.parse(res.text) as {
        procedure: { createdByAgentId: string | null; createdByRuntime: string | null }
      }
    ).procedure
    expect(proc.createdByAgentId).toBe('agent-1')
    expect(proc.createdByRuntime).toBe('claude-code')
  })

  it('a bound save without explicit provenance still records the bound agent', async () => {
    const writer = await connect({ boundScope: { teamId: 'team-A', agentId: 'agent-1' } })
    const fact = await saveFact(writer)
    expect(fact.createdByAgentId).toBe('agent-1')
    expect(fact.createdByRuntime).toBeNull()
  })

  it('an unbound save records NO provenance (model-supplied ids are spoofable)', async () => {
    const writer = await connect()
    const res = await callText(writer, 'memory_save', {
      title: 'X',
      content: 'y',
      scopeAgentId: 'agent-claimed',
    })
    const fact = (JSON.parse(res.text) as SavedFact).fact
    expect(fact.createdByAgentId).toBeNull()
    expect(fact.createdByRuntime).toBeNull()
    expect(fact.sourceTaskId).toBeNull()
    expect(fact.sourceSessionKey).toBeNull()
  })
})
