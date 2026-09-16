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

describe('parseBoundProvenance', () => {
  it('parses agent + prov* stamps from the URL query', () => {
    expect(
      parseBoundProvenance(
        req(
          '/api/mcp/memory?scopeAgentId=agent-1&provRuntime=claude-code&provTaskId=task-9&provSessionKey=sess-1',
        ),
      ),
    ).toEqual({
      agentId: 'agent-1',
      runtime: 'claude-code',
      taskId: 'task-9',
      sessionKey: 'sess-1',
    })
    // Partial stamps: only what is present.
    expect(parseBoundProvenance(req('/api/mcp/memory?provRuntime=codex'))).toEqual({
      runtime: 'codex',
    })
    expect(parseBoundProvenance(req('/api/mcp/memory?scopeAgentId=agent-1'))).toEqual({
      agentId: 'agent-1',
    })
  })

  it('returns undefined when no provenance params are present', () => {
    expect(parseBoundProvenance(req('/api/mcp/memory'))).toBeUndefined()
    expect(parseBoundProvenance(req('/api/mcp/memory?scopeTeamId=T'))).toBeUndefined()
    expect(parseBoundProvenance(undefined)).toBeUndefined()
    expect(parseBoundProvenance(req(''))).toBeUndefined()
  })

  it('is provenance-only: an unsigned scoped URL still parses stamps here while parseBoundScope refuses it', () => {
    // prov* params ride OUTSIDE the scopeSig HMAC — parseBoundProvenance stays a
    // pure parser, and the memory handler gates it on a VERIFIED bound scope.
    const url = '/api/mcp/memory?scopeTeamId=T&scopeAgentId=A&provTaskId=task-1'
    expect(parseBoundScope(req(url))).toBeUndefined()
    expect(parseBoundProvenance(req(url))).toEqual({ agentId: 'A', taskId: 'task-1' })
  })
})
