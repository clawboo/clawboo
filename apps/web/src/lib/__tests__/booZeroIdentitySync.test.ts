import { describe, it, expect, vi } from 'vitest'
import type { GatewayClientLike } from '@clawboo/gateway-client'
import { syncBooZeroSoulIdentity, __test__ } from '../booZeroIdentitySync'

// Mock clients with generic `call<T>` signatures need the cast to match
// the `GatewayClientLike` interface — `vi.fn` returns a concrete-typed
// `Mock` that TS can't widen to a generic call signature.
type MockClient = { call: ReturnType<typeof vi.fn> }
function asClient(m: MockClient): GatewayClientLike {
  return m as unknown as GatewayClientLike
}

const { rewriteSoulHeading } = __test__

describe('rewriteSoulHeading', () => {
  it('replaces the leading heading with the new name', () => {
    const before = '# Mythos\n\nResident ancient oracle.'
    const after = rewriteSoulHeading(before, 'Boo Zero')
    expect(after).toMatch(/^# Boo Zero\n\n/)
    expect(after).toContain('Resident ancient oracle.')
  })

  it('prepends a heading when none exists', () => {
    const before = 'Some role description without a heading.\n'
    const after = rewriteSoulHeading(before, 'Boo Zero')
    expect(after).toMatch(/^# Boo Zero\n\n/)
    expect(after).toContain('Some role description')
  })

  it('preserves later content (personality block, About-the-User, etc.)', () => {
    const before =
      '# old name\n\nRole description.\n\n---\n<!-- clawboo:personality -->\nFormality: 80\n\n## About the User\nSanjay is shipping Clawboo.\n'
    const after = rewriteSoulHeading(before, 'Boo Zero')
    expect(after).toMatch(/^# Boo Zero\n\n/)
    expect(after).toContain('Role description.')
    expect(after).toContain('clawboo:personality')
    expect(after).toContain('Formality: 80')
    expect(after).toContain('## About the User')
    expect(after).toContain('Sanjay is shipping Clawboo.')
  })

  it('is a no-op when the empty / whitespace name is passed', () => {
    const before = '# Mythos\n\nstuff'
    expect(rewriteSoulHeading(before, '')).toBe(before)
    expect(rewriteSoulHeading(before, '   ')).toBe(before)
  })

  it('idempotent — calling with the same name twice produces the same output', () => {
    const before = '# Whatever\n\nstuff\n'
    const once = rewriteSoulHeading(before, 'Boo Zero')
    const twice = rewriteSoulHeading(once, 'Boo Zero')
    expect(once).toBe(twice)
  })
})

describe('syncBooZeroSoulIdentity', () => {
  it('reads SOUL.md, rewrites the heading, writes back', async () => {
    const calls: { method: string; params: unknown }[] = []
    const client = {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'agents.files.get') {
          return { file: { content: '# Mythos\n\nrole' } }
        }
        return { ok: true }
      }),
    }
    const ok = await syncBooZeroSoulIdentity({
      client: asClient(client),
      agentId: 'a1',
      displayName: 'Boo Zero',
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.method).toBe('agents.files.get')
    expect(calls[1]!.method).toBe('agents.files.set')
    const setParams = calls[1]!.params as { name: string; content: string }
    expect(setParams.name).toBe('SOUL.md')
    expect(setParams.content).toMatch(/^# Boo Zero\n\n/)
  })

  it('handles missing SOUL.md by prepending the heading to empty content', async () => {
    const calls: { method: string; params: unknown }[] = []
    const client = {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'agents.files.get') return { file: { missing: true } }
        return { ok: true }
      }),
    }
    const ok = await syncBooZeroSoulIdentity({
      client: asClient(client),
      agentId: 'a1',
      displayName: 'Boo Zero',
    })
    expect(ok).toBe(true)
    const setCall = calls.find((c) => c.method === 'agents.files.set')
    expect(setCall).toBeDefined()
    // SOUL.md was empty → no blank line between heading and (nonexistent)
    // body is fine. We just require the heading lands cleanly at line 1.
    expect((setCall!.params as { content: string }).content).toMatch(/^# Boo Zero\n/)
  })

  it('returns false when the SOUL.md write itself throws', async () => {
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === 'agents.files.get') return { file: { content: '# X\n' } }
        if (method === 'agents.files.set') throw new Error('Gateway 500')
        return { ok: true }
      }),
    }
    const ok = await syncBooZeroSoulIdentity({
      client: asClient(client),
      agentId: 'a1',
      displayName: 'Boo Zero',
    })
    expect(ok).toBe(false)
  })

  it('refuses to sync when the display name is empty', async () => {
    const client = { call: vi.fn(async () => ({ ok: true })) }
    const ok = await syncBooZeroSoulIdentity({
      client: asClient(client),
      agentId: 'a1',
      displayName: '',
    })
    expect(ok).toBe(false)
    expect(client.call).not.toHaveBeenCalled()
  })
})
