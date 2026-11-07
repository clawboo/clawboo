// parseBoundScope: reads the run's authoritative memory scope from the MCP
// attach URL's query params — and honours it ONLY when the URL carries a valid
// `scopeSig`. The params alone used to be the authority ("the URL is
// clawboo-written config"), which holds only while the runtime uses the config
// it was handed: a coding runtime can edit its own home. These tests assert the
// full adversarial matrix: clawboo-signed URLs bind, everything else serves
// unbound.

import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { mcpHttpUrl } from '@clawboo/mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../lib/db'
import { getMcpAttachSecret } from '../../lib/mcpAttachSecret'
import { parseBoundProvenance, parseBoundScope, parseTasksBinding, parseToolsBinding } from '../mcp'

const req = (url: string): IncomingMessage => ({ url }) as IncomingMessage

let dir: string
const prev: Record<string, string | undefined> = {}
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-mcpscope-'))
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    prev[name] = process.env[name]
    process.env[name] = dir
  }
  expect(getDbPath().startsWith(dir)).toBe(true)
})
afterAll(() => {
  resetDb()
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    if (prev[name] === undefined) delete process.env[name]
    else process.env[name] = prev[name]
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A URL exactly as clawboo's own producers write it. */
const signedUrl = (scope: { teamId?: string; agentId?: string; tenantId?: string }): string =>
  mcpHttpUrl('http://127.0.0.1:1', 'memory', {
    ...scope,
    attachSecret: getMcpAttachSecret(getDb()),
  }).replace('http://127.0.0.1:1', '')

describe('parseBoundScope — signed URLs bind', () => {
  it('honours a clawboo-signed scope end to end (producer → parser)', () => {
    const url = signedUrl({ teamId: 'team-A', agentId: 'agent-1' })
    expect(parseBoundScope(req(url))).toEqual({ teamId: 'team-A', agentId: 'agent-1' })
  })

  it('returns undefined when no scope params are present (unbound / external attach)', () => {
    expect(parseBoundScope(req('/api/mcp/memory'))).toBeUndefined()
    expect(parseBoundScope(req('/api/mcp/memory?foo=bar'))).toBeUndefined()
    expect(parseBoundScope(undefined)).toBeUndefined()
    expect(parseBoundScope(req(''))).toBeUndefined()
  })
})

describe('parseBoundScope — everything else serves unbound', () => {
  it('UNSIGNED scope params are refused, not honoured', () => {
    // The pre-fix behaviour: these bound the session. That is the vulnerability —
    // any process that can reach loopback could claim any agent's identity.
    expect(
      parseBoundScope(req('/api/mcp/memory?scopeTeamId=team-A&scopeAgentId=agent-1')),
    ).toBeUndefined()
  })

  it('a TAMPERED field breaks the signature', () => {
    // Take clawboo's own signed URL and swap the agent — the mailbox-piggyback
    // escalation: mark another agent's rows delivered by claiming its id.
    const url = signedUrl({ teamId: 'team-A', agentId: 'agent-1' })
    const forged = url.replace('scopeAgentId=agent-1', 'scopeAgentId=victim')
    expect(forged).toContain('victim') // the edit really landed
    expect(parseBoundScope(req(forged))).toBeUndefined()
  })

  it('a signature minted under a DIFFERENT secret is refused', () => {
    const url = signedUrl({ teamId: 'T', agentId: 'A' })
    const withBadSig = url.replace(/scopeSig=[0-9a-f]+/, `scopeSig=${'ab'.repeat(32)}`)
    expect(parseBoundScope(req(withBadSig))).toBeUndefined()
  })

  it('a garbage signature is refused without throwing', () => {
    const url = signedUrl({ teamId: 'T', agentId: 'A' }).replace(
      /scopeSig=[0-9a-f]+/,
      'scopeSig=not-hex-at-all',
    )
    expect(parseBoundScope(req(url))).toBeUndefined()
  })
})

/** A Memory URL carrying provenance, signed exactly as clawboo's producers sign it. */
const signedProvUrl = (prov: {
  agentId?: string
  runtime?: string
  taskId?: string
  sessionKey?: string
}): string =>
  mcpHttpUrl('http://127.0.0.1:1', 'memory', {
    teamId: 'T',
    ...prov,
    attachSecret: getMcpAttachSecret(getDb()),
  }).replace('http://127.0.0.1:1', '')

describe('parseBoundProvenance', () => {
  it('honours clawboo-signed stamps end to end (producer → parser)', () => {
    const url = signedProvUrl({
      agentId: 'agent-1',
      runtime: 'claude-code',
      taskId: 'task-9',
      sessionKey: 'sess-1',
    })
    expect(url).toContain('provSig=')
    expect(parseBoundProvenance(req(url))).toEqual({
      agentId: 'agent-1',
      runtime: 'claude-code',
      taskId: 'task-9',
      sessionKey: 'sess-1',
    })
    // Partial stamps: only what is present.
    expect(parseBoundProvenance(req(signedProvUrl({ agentId: 'a', runtime: 'codex' })))).toEqual({
      agentId: 'a',
      runtime: 'codex',
    })
  })

  it('returns undefined when no provenance params are present', () => {
    expect(parseBoundProvenance(req('/api/mcp/memory'))).toBeUndefined()
    expect(parseBoundProvenance(req('/api/mcp/memory?scopeTeamId=T'))).toBeUndefined()
    expect(parseBoundProvenance(undefined)).toBeUndefined()
    expect(parseBoundProvenance(req(''))).toBeUndefined()
  })

  it('keeps the agent (scopeSig covers it) but drops UNSIGNED stamps', () => {
    const url =
      '/api/mcp/memory?scopeAgentId=agent-1&provRuntime=claude-code&provTaskId=task-9&provSessionKey=s'
    expect(parseBoundProvenance(req(url))).toEqual({ agentId: 'agent-1' })
    expect(parseBoundProvenance(req('/api/mcp/memory?provRuntime=codex'))).toBeUndefined()
  })

  it('an EDITED task id breaks the stamp signature (the corroboration forgery)', () => {
    // One agent re-attaching under a new task id would count as a second,
    // independent corroborator and promote a fact on its own.
    const url = signedProvUrl({ agentId: 'agent-1', taskId: 'task-1' })
    const forged = url.replace('provTaskId=task-1', 'provTaskId=task-2')
    expect(forged).toContain('task-2')
    expect(parseBoundProvenance(req(forged))).toEqual({ agentId: 'agent-1' })
  })

  it("a stamp signed for one agent does not verify on another agent's URL", () => {
    const url = signedProvUrl({ agentId: 'agent-1', taskId: 'task-1' })
    const moved = url.replace('scopeAgentId=agent-1', 'scopeAgentId=agent-2')
    expect(parseBoundProvenance(req(moved))).toEqual({ agentId: 'agent-2' })
  })

  it('a scope signature is not accepted as a stamp signature', () => {
    const url = signedProvUrl({ agentId: 'agent-1', taskId: 'task-1' })
    const scopeSig = /scopeSig=([0-9a-f]+)/.exec(url)![1]!
    const swapped = url.replace(/provSig=[0-9a-f]+/, `provSig=${scopeSig}`)
    expect(parseBoundProvenance(req(swapped))).toEqual({ agentId: 'agent-1' })
  })
})

/** A Tasks URL as serverDeliver (a team run) or the task runner writes it. */
const signedTasksUrl = (scope: {
  teamId: string
  agentId: string
  delegate?: boolean
  boundTaskId?: string
  boundExecutionId?: string
}): string =>
  mcpHttpUrl('http://127.0.0.1:1', 'tasks', {
    ...scope,
    attachSecret: getMcpAttachSecret(getDb()),
  }).replace('http://127.0.0.1:1', '')

describe('parseBoundScope on a team run', () => {
  const teamRunMemoryUrl = (): string =>
    mcpHttpUrl('http://127.0.0.1:1', 'memory', {
      teamId: 'team-A',
      agentId: 'coder',
      delegate: true,
      attachSecret: getMcpAttachSecret(getDb()),
    }).replace('http://127.0.0.1:1', '')

  it('binds the Memory URL a team run is given, which carries the team-run mark', () => {
    const url = teamRunMemoryUrl()
    expect(url).toContain('teamRun=1')
    expect(parseBoundScope(req(url))).toEqual({ teamId: 'team-A', agentId: 'coder' })
  })

  it('refuses it with the mark stripped', () => {
    expect(parseBoundScope(req(teamRunMemoryUrl().replace(/&?teamRun=1/, '')))).toBeUndefined()
  })
})

describe('parseTasksBinding', () => {
  it('reads a team run from the signed Tasks URL a team run is given', () => {
    const url = signedTasksUrl({ teamId: 'team-A', agentId: 'coder', delegate: true })
    expect(parseTasksBinding(req(url))).toEqual({
      scope: { teamId: 'team-A', agentId: 'coder' },
      teamRun: true,
    })
  })

  it('reads any other signed run as no team run', () => {
    const url = signedTasksUrl({ teamId: 'team-A', agentId: 'coder' })
    expect(parseTasksBinding(req(url))).toEqual({
      scope: { teamId: 'team-A', agentId: 'coder' },
      teamRun: false,
    })
  })

  it('refuses a team-run URL with the claim stripped, so editing the config cannot win the writes back', () => {
    const url = signedTasksUrl({ teamId: 'team-A', agentId: 'coder', delegate: true })
    const stripped = url.replace(/&?teamRun=1/, '')
    expect(stripped).not.toContain('teamRun')
    expect(parseTasksBinding(req(stripped))).toBeUndefined()
  })

  it('refuses a claim appended to a URL that was not signed with it', () => {
    const url = signedTasksUrl({ teamId: 'team-A', agentId: 'coder' })
    expect(parseTasksBinding(req(`${url}&teamRun=1`))).toBeUndefined()
  })

  it('is unbound with no scope at all (an OpenClaw agent, an external attach)', () => {
    expect(parseTasksBinding(req('/api/mcp/tasks'))).toBeUndefined()
    expect(parseTasksBinding(undefined)).toBeUndefined()
  })
})

// The run's own task rides the Tasks URL inside its signature, so the Tasks
// tools can default to it; a runtime editing its config can neither move that
// default to another task nor add one.
describe('parseTasksBinding: the run’s own task', () => {
  const onTask = { teamId: 'team-A', agentId: 'coder', delegate: true, boundTaskId: 'task-1' }

  it('reads the task a team run is bound to', () => {
    expect(parseTasksBinding(req(signedTasksUrl(onTask)))).toEqual({
      scope: { teamId: 'team-A', agentId: 'coder' },
      teamRun: true,
      taskId: 'task-1',
    })
  })

  it('refuses the URL when the task was moved, stripped or added', () => {
    const url = signedTasksUrl(onTask)
    expect(
      parseTasksBinding(req(url.replace('scopeTaskId=task-1', 'scopeTaskId=task-2'))),
    ).toBeUndefined()
    expect(parseTasksBinding(req(url.replace(/&?scopeTaskId=task-1/, '')))).toBeUndefined()
    const plain = signedTasksUrl({ teamId: 'team-A', agentId: 'coder', delegate: true })
    expect(parseTasksBinding(req(`${plain}&scopeTaskId=task-1`))).toBeUndefined()
  })

  it('leaves the Memory binding alone: the Memory URL carries no task', () => {
    const memory = mcpHttpUrl('http://127.0.0.1:1', 'memory', {
      ...onTask,
      attachSecret: getMcpAttachSecret(getDb()),
    }).replace('http://127.0.0.1:1', '')
    expect(memory).not.toContain('scopeTaskId')
    expect(parseBoundScope(req(memory))).toEqual({ teamId: 'team-A', agentId: 'coder' })
  })
})

// The run's id rides the Tasks URL inside its signature, so a write the session
// makes records its agent and its run.
describe('parseTasksBinding: the run’s id', () => {
  const onRun = {
    teamId: 'team-A',
    agentId: 'coder',
    delegate: true,
    boundTaskId: 'task-1',
    boundExecutionId: 'exec-1',
  }

  it('reads the run a session is bound to', () => {
    expect(parseTasksBinding(req(signedTasksUrl(onRun)))).toEqual({
      scope: { teamId: 'team-A', agentId: 'coder' },
      teamRun: true,
      taskId: 'task-1',
      executionId: 'exec-1',
    })
  })

  it('refuses the URL when the id was moved, stripped or added', () => {
    const url = signedTasksUrl(onRun)
    expect(
      parseTasksBinding(req(url.replace('scopeExecutionId=exec-1', 'scopeExecutionId=exec-2'))),
    ).toBeUndefined()
    expect(parseTasksBinding(req(url.replace(/&?scopeExecutionId=exec-1/, '')))).toBeUndefined()
    const plain = signedTasksUrl({ ...onRun, boundExecutionId: undefined })
    expect(parseTasksBinding(req(`${plain}&scopeExecutionId=exec-1`))).toBeUndefined()
  })

  it('still reads a URL minted before there was a run id', () => {
    const plain = signedTasksUrl({ ...onRun, boundExecutionId: undefined })
    expect(parseTasksBinding(req(plain))?.executionId).toBeUndefined()
    expect(parseTasksBinding(req(plain))?.taskId).toBe('task-1')
  })
})

// The bound task rides the Tools URL too, so an approval the broker opens names
// the task. Signed like the Tasks URL's: a runtime cannot point its approvals at
// another task's card.
describe('parseToolsBinding', () => {
  const toolsUrl = (scope: { boundTaskId?: string; boundExecutionId?: string } = {}): string =>
    mcpHttpUrl('http://127.0.0.1:1', 'tools', {
      teamId: 'team-A',
      agentId: 'coder',
      delegate: true,
      ...scope,
      attachSecret: getMcpAttachSecret(getDb()),
    }).replace('http://127.0.0.1:1', '')

  it('reads the agent, the team and the task', () => {
    expect(parseToolsBinding(req(toolsUrl({ boundTaskId: 'task-1' })))).toEqual({
      scope: { teamId: 'team-A', agentId: 'coder' },
      taskId: 'task-1',
    })
  })

  it('reads a run with no task, as it always did', () => {
    expect(parseToolsBinding(req(toolsUrl()))).toEqual({
      scope: { teamId: 'team-A', agentId: 'coder' },
    })
  })

  it('refuses the URL when the task was moved, stripped or added', () => {
    const url = toolsUrl({ boundTaskId: 'task-1' })
    expect(
      parseToolsBinding(req(url.replace('scopeTaskId=task-1', 'scopeTaskId=task-2'))),
    ).toBeUndefined()
    expect(parseToolsBinding(req(url.replace(/&?scopeTaskId=task-1/, '')))).toBeUndefined()
    expect(parseToolsBinding(req(`${toolsUrl()}&scopeTaskId=task-1`))).toBeUndefined()
  })

  it('is unbound with no scope at all', () => {
    expect(parseToolsBinding(req('/api/mcp/tools'))).toBeUndefined()
    expect(parseToolsBinding(undefined)).toBeUndefined()
  })
})
