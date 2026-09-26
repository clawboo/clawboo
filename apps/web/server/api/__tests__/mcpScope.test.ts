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

import { getDb, resetDb } from '../../lib/db'
import { getMcpAttachSecret, resetMcpAttachSecretCache } from '../../lib/mcpAttachSecret'
import { parseBoundProvenance, parseBoundScope } from '../mcp'

const req = (url: string): IncomingMessage => ({ url }) as IncomingMessage

let dir: string
let prevHome: string | undefined
beforeAll(() => {
  prevHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-mcpscope-'))
  process.env['CLAWBOO_HOME'] = dir
  resetMcpAttachSecretCache()
})
afterAll(() => {
  resetDb()
  resetMcpAttachSecretCache()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
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
