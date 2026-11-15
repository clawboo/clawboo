// Every API route has a rule, and the guard in front of it applies that rule.
// Read off the real router, so a route added without a rule fails here.

import { describe, expect, it } from 'vitest'

import type { Request } from 'express'

import { GUARD_RULE } from '../guard'
import { PERMISSIONS, type Permission } from '../policy'
import { ROUTE_RULES, type Need, type RouteRule } from '../rules'

interface Layer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: unknown }>
  }
}

async function servedRoutes(): Promise<Map<string, Layer['route'] & object>> {
  const { apiRouter } = await import('../../../api/index')
  const out = new Map<string, NonNullable<Layer['route']>>()
  for (const layer of (apiRouter as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) continue
    for (const method of Object.keys(layer.route.methods)) {
      out.set(`${method.toUpperCase()} ${layer.route.path}`, layer.route)
    }
  }
  return out
}

function needOf(rule: RouteRule, req: Partial<Request> = {}): readonly Permission[] {
  const need: Need =
    typeof rule.need === 'function'
      ? rule.need({ params: {}, query: {}, body: {}, ...req } as Request)
      : rule.need
  return typeof need === 'string' ? [need] : need
}

describe('route rules', () => {
  it('has a rule for every route the server serves, and none for a route it does not', async () => {
    const served = await servedRoutes()
    const unruled = [...served.keys()].filter((key) => !(key in ROUTE_RULES))
    const stale = Object.keys(ROUTE_RULES).filter((key) => !served.has(key))
    expect(unruled).toEqual([])
    expect(stale).toEqual([])
  })

  it("puts each route's own rule in a guard ahead of every handler", async () => {
    const served = await servedRoutes()
    for (const [key, route] of served) {
      const first = route.stack[0]?.handle as Record<symbol, unknown> | undefined
      expect(first?.[GUARD_RULE], key).toBe(ROUTE_RULES[key])
    }
  })

  it('names only permissions that exist', () => {
    for (const [key, rule] of Object.entries(ROUTE_RULES)) {
      if (typeof rule.need === 'function') continue
      for (const p of needOf(rule)) expect(PERMISSIONS, key).toContain(p)
    }
  })

  it('lets any verified person reach only the routes that are about the person or the engine', () => {
    const anyPerson = Object.entries(ROUTE_RULES)
      .filter(([, rule]) => typeof rule.need !== 'function' && needOf(rule).length === 0)
      .map(([key]) => key)
      .sort()
    expect(anyPerson).toEqual([
      'GET /api/access/identity',
      'GET /api/health',
      'GET /api/system/capabilities',
      'POST /api/system/presence',
    ])
  })

  it('marks only the four MCP mounts as a runtime call', () => {
    const runtime = Object.entries(ROUTE_RULES)
      .filter(([, rule]) => rule.runtime === true)
      .map(([key]) => key.split(' ')[1])
    expect(new Set(runtime)).toEqual(
      new Set(['/api/mcp/tasks', '/api/mcp/memory', '/api/mcp/tools', '/api/mcp/teamchat']),
    )
  })

  it('needs approve to answer an approval, and standing for an answer that lasts', () => {
    const resolve = ROUTE_RULES['POST /api/tools/approvals/:id/resolve']!
    expect(needOf(resolve)).toEqual(['approve'])
    expect(resolve.more?.({ body: { decision: 'allow_always' } } as Request)).toBe('standing')
    expect(resolve.more?.({ body: { decision: 'allow_once' } } as Request)).toBeNull()

    const capabilities = ROUTE_RULES['POST /api/capabilities/:action']!
    const approve = { params: { action: 'approve' }, body: { decision: 'allow_always' } }
    expect(needOf(capabilities, approve as Partial<Request>)).toEqual(['approve'])
    expect(capabilities.more?.(approve as unknown as Request)).toBe('standing')
    expect(needOf(capabilities, { params: { action: 'enable' } } as Partial<Request>)).toEqual([
      'setup',
    ])
    expect(needOf(capabilities, { params: { action: 'disable' } } as Partial<Request>)).toEqual([
      'tighten',
    ])
    expect(needOf(capabilities, { params: { action: 'nope' } } as Partial<Request>)).toEqual([
      'system',
    ])

    const openclaw = ROUTE_RULES['POST /api/approvals']!
    expect(needOf(openclaw)).toEqual(['approve'])
    expect(openclaw.more?.({ body: { action: 'allow-always' } } as Request)).toBe('standing')
  })

  it('needs the owner for a grant that never asks', () => {
    const grant = ROUTE_RULES['POST /api/grants']!
    expect(needOf(grant)).toEqual(['setup'])
    expect(grant.more?.({ body: { approvalPolicy: 'never' } } as Request)).toBe('standing')
    expect(grant.more?.({ body: { approvalPolicy: 'risk' } } as Request)).toBeNull()
  })

  it('opens to a guest only routes that need nothing beyond see or work', () => {
    for (const [key, rule] of Object.entries(ROUTE_RULES)) {
      if (!rule.guest) continue
      const need = needOf(rule)
      const more = rule.more?.({ params: {}, query: {}, body: {} } as Request) ?? null
      expect(more, key).toBeNull()
      expect(
        need.every((p) => p === 'see' || p === 'work'),
        key,
      ).toBe(true)
    }
  })

  it('keeps the OpenClaw settings, keys and installs to the operator', () => {
    for (const key of [
      'POST /api/settings',
      'POST /api/providers/:id/connect',
      'POST /api/runtimes/:id/connect',
      'PATCH /api/system/openclaw-config',
      'POST /api/system/self-update',
      'GET /api/mcp/config',
    ]) {
      expect(needOf(ROUTE_RULES[key]!), key).toEqual(['system'])
    }
  })
})
