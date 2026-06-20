import { describe, it, expect, vi, afterEach } from 'vitest'
import { syncBooZeroSoulIdentity, __test__ } from '../booZeroIdentitySync'

// syncBooZeroSoulIdentity now routes file I/O through the AgentSource REST surface
// (readAgentFile = GET /api/agents/:id/files/:name, writeAgentFile = PUT), so the
// tests mock global fetch. Each call records { method, url } so we can assert the
// read-then-write order.
interface FetchCall {
  method: string
  url: string
  body: unknown
}
function mockFetch(handler: (method: string, url: string) => { status: number; body: unknown }) {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url: input, body: init?.body ? JSON.parse(init.body) : undefined })
      const { status, body } = handler(method, input)
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as Response)
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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
      '# old name\n\nRole description.\n\n---\n<!-- clawboo:personality -->\nFormality: 80\n\n## About the User\nAlex is shipping Clawboo.\n'
    const after = rewriteSoulHeading(before, 'Boo Zero')
    expect(after).toMatch(/^# Boo Zero\n\n/)
    expect(after).toContain('Role description.')
    expect(after).toContain('clawboo:personality')
    expect(after).toContain('Formality: 80')
    expect(after).toContain('## About the User')
    expect(after).toContain('Alex is shipping Clawboo.')
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
    const calls = mockFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { name: 'SOUL.md', content: '# Mythos\n\nrole' } }
        : { status: 200, body: { name: 'SOUL.md', content: '' } },
    )
    const ok = await syncBooZeroSoulIdentity({ agentId: 'a1', displayName: 'Boo Zero' })
    expect(ok).toBe(true)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[1]!.method).toBe('PUT')
    expect(calls[1]!.url).toContain('/api/agents/a1/files/SOUL.md')
    expect((calls[1]!.body as { content: string }).content).toMatch(/^# Boo Zero\n\n/)
  })

  it('handles missing SOUL.md by prepending the heading to empty content', async () => {
    const calls = mockFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { content: '' } }
        : { status: 200, body: { content: '' } },
    )
    const ok = await syncBooZeroSoulIdentity({ agentId: 'a1', displayName: 'Boo Zero' })
    expect(ok).toBe(true)
    expect(calls.some((c) => c.method === 'PUT')).toBe(true)
  })

  it('returns false when the SOUL.md write itself fails', async () => {
    mockFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { content: '# X\n' } }
        : { status: 503, body: { error: 'gateway_disconnected' } },
    )
    const ok = await syncBooZeroSoulIdentity({ agentId: 'a1', displayName: 'Boo Zero' })
    expect(ok).toBe(false)
  })

  it('refuses to sync when the display name is empty', async () => {
    const calls = mockFetch(() => ({ status: 200, body: {} }))
    const ok = await syncBooZeroSoulIdentity({ agentId: 'a1', displayName: '' })
    expect(ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
