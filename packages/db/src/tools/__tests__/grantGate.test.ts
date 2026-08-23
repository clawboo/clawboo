// The grant gate, and the one regression that would matter most: a tool that
// works today must still work after the gate exists.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDb, type ClawbooDb } from '../../db'
import { upsertGrant, revokeGrant } from '../../grants/repository'
import { callsInWindow, chargeCall, resetRateWindows } from '../../grants/rateWindow'
import { defaultAvailabilityContext } from '../availability'
import { executeBrokeredCall } from '../broker'
import { chargeGrantCall, releaseGrantCharge } from '../grantGate'
import { ToolRegistry } from '../registry'
import { createBuiltinRegistry } from '../registry'
import type { ToolCallContext, ToolDescriptor } from '../types'

const CONNECTOR = 'conn:native:clawboo-native:mcp:github'

function ctx(over: Partial<ToolCallContext> = {}): ToolCallContext {
  return { availability: defaultAvailabilityContext({ env: {} }), ...over }
}

/** A connector-owned tool: exactly what an outbound MCP client will register. */
function connectorTool(over: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: 'gh_read',
    description: 'read',
    inputSchema: z.object({}),
    owner: 'mcp',
    readOnly: true,
    executor: () => 'ok',
    ...over,
  }
}

describe('the grant gate', () => {
  let dir: string
  let db: ClawbooDb

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-gate-'))
    db = createDb(path.join(dir, 'test.db'))
    resetRateWindows()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('does NOT gate a core builtin, so nothing callable today changes', () => {
    // The regression that would matter most. Every brokered tool that ships is
    // owner:'core', so the gate must be structurally unreachable for them.
    const registry = createBuiltinRegistry()
    return executeBrokeredCall(db, { name: 'echo', args: { message: 'hi' } }, ctx(), {
      registry,
    }).then((res) => {
      expect(res.ok).toBe(true)
      expect(res.denied).toBeUndefined()
    })
  })

  it('does NOT gate a non-core tool when the caller supplies no connectorId', () => {
    // The identity has to come from the caller: it contains ':' and cannot
    // survive an MCP tool name. With none in hand there is no grant to look up,
    // and inventing one would gate calls on a guess.
    const registry = new ToolRegistry()
    registry.register(connectorTool())
    return executeBrokeredCall(db, { name: 'gh_read', args: {} }, ctx(), { registry }).then((res) =>
      expect(res.ok).toBe(true),
    )
  })

  it('DENIES a connector tool with no grant', async () => {
    const registry = new ToolRegistry()
    registry.register(connectorTool())
    const res = await executeBrokeredCall(
      db,
      { name: 'gh_read', args: {} },
      ctx({ agentId: 'a1', connectorId: CONNECTOR }),
      { registry },
    )
    expect(res.ok).toBe(false)
    expect(res.denied).toBe('grant:no-grant')
  })

  it('ALLOWS it once a grant exists, and attributes the audit rows', async () => {
    const grant = upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      mode: 'admin',
      approvalPolicy: 'never',
    })
    const registry = new ToolRegistry()
    registry.register(connectorTool())

    const res = await executeBrokeredCall(
      db,
      { name: 'gh_read', args: {} },
      ctx({ agentId: 'a1', connectorId: CONNECTOR }),
      { registry },
    )
    expect(res.ok).toBe(true)

    // Both phases must carry the grant. The `after` row is the only producer
    // lastUsedByGrant reads, so an unattributed one makes "last used" forever null.
    const rows = db.$client
      .prepare('SELECT phase, grant_id, connector_id FROM tool_call_audit ORDER BY phase')
      .all() as Array<{ phase: string; grant_id: string | null; connector_id: string | null }>
    expect(rows.map((r) => r.phase)).toEqual(['after', 'before'])
    for (const r of rows) {
      expect(r.grant_id).toBe(grant.id)
      expect(r.connector_id).toBe(CONNECTOR)
    }
  })

  it('DENIES again once the grant is revoked', async () => {
    const grant = upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      mode: 'admin',
      approvalPolicy: 'never',
    })
    revokeGrant(db, grant.id, 'detached')

    const registry = new ToolRegistry()
    registry.register(connectorTool())
    const res = await executeBrokeredCall(
      db,
      { name: 'gh_read', args: {} },
      ctx({ agentId: 'a1', connectorId: CONNECTOR }),
      { registry },
    )
    expect(res.denied).toBe('grant:grant-revoked')
  })

  it('DENIES a write tool under a read-mode grant', async () => {
    upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: CONNECTOR,
      capabilityId: null,
      mode: 'read',
      approvalPolicy: 'never',
    })
    const registry = new ToolRegistry()
    // No readOnly annotation => requiredMode is 'write'. This is THE annotation
    // trap: until an MCP client threads real ToolAnnotations, a read-mode grant
    // denies every unannotated tool. Pinned here so it is a known property
    // rather than a mystery bug report.
    registry.register(connectorTool({ name: 'gh_write', readOnly: undefined }))
    const res = await executeBrokeredCall(
      db,
      { name: 'gh_write', args: {} },
      ctx({ agentId: 'a1', connectorId: CONNECTOR }),
      { registry },
    )
    expect(res.denied).toBe('grant:mode-insufficient')
  })

  it('charges the rate window for an approved call, exactly once', () => {
    // Charging only an immediate `allow` lets a grant that combines an approval
    // policy with a ceiling exceed that ceiling forever: every call prompts,
    // every prompt is approved, and nothing is ever counted.
    const gate = { decision: { kind: 'allow', grantId: 'g1' }, connectorId: 'c1', charged: false }
    chargeGrantCall(gate as never)
    expect(callsInWindow('g1')).toBe(1)

    // Idempotent: a result already charged at decision time is left alone.
    chargeGrantCall(gate as never)
    expect(callsInWindow('g1')).toBe(1)

    releaseGrantCharge(gate as never)
    expect(callsInWindow('g1')).toBe(0)
  })

  it('releases a charge only once, so a double release cannot go negative', () => {
    chargeCall('g2')
    const gate = { decision: { kind: 'allow', grantId: 'g2' }, connectorId: 'c1', charged: true }
    releaseGrantCharge(gate as never)
    releaseGrantCharge(gate as never)
    expect(callsInWindow('g2')).toBe(0)
  })

  it('emits a grant_decision event for every gated call', async () => {
    const registry = new ToolRegistry()
    registry.register(connectorTool())
    await executeBrokeredCall(
      db,
      { name: 'gh_read', args: {} },
      ctx({ agentId: 'a1', connectorId: CONNECTOR }),
      { registry },
    )
    const rows = db.$client
      .prepare("SELECT kind, data FROM orchestration_events WHERE kind = 'grant_decision'")
      .all() as Array<{ kind: string; data: string }>
    expect(rows).toHaveLength(1)
    const data = JSON.parse(rows[0]!.data) as Record<string, unknown>
    expect(data['decision']).toBe('deny')
    expect(data['reason']).toBe('no-grant')
    expect(data['toolName']).toBe('gh_read')
  })
})
