// Building a broker call from the broker's own schema.
//
// The point of these is the refusals. clawboo cannot test against the live
// broker, so the only defence against calling a tool it has misunderstood is to
// refuse loudly when the schema is not the shape it expects.

import { describe, expect, it } from 'vitest'

import { approvalUrlFrom, buildLinkArgs, isRefusal } from '../brokeredLink'

const schema = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  ...(required.length > 0 ? { required } : {}),
})

describe('buildLinkArgs', () => {
  it('puts the app in the field the schema names', () => {
    const args = buildLinkArgs(schema({ toolkit: { type: 'string' } }), 'gmail')
    expect(args).toEqual({ toolkit: 'gmail' })
  })

  it('follows the schema when the broker calls it something else', () => {
    expect(buildLinkArgs(schema({ app: { type: 'string' } }), 'slack')).toEqual({ app: 'slack' })
    expect(buildLinkArgs(schema({ appName: { type: 'string' } }), 'jira')).toEqual({
      appName: 'jira',
    })
  })

  it('matches a field name case-insensitively', () => {
    expect(buildLinkArgs(schema({ Toolkit: { type: 'string' } }), 'gmail')).toEqual({
      Toolkit: 'gmail',
    })
  })

  it('picks the create member out of an action enum', () => {
    const args = buildLinkArgs(
      schema({ toolkit: { type: 'string' }, action: { enum: ['list', 'create', 'remove'] } }),
      'gmail',
    )
    expect(args).toEqual({ toolkit: 'gmail', action: 'create' })
  })

  it('accepts a differently worded create member', () => {
    const args = buildLinkArgs(
      schema({ toolkit: { type: 'string' }, action: { enum: ['LIST', 'INITIATE_CONNECTION'] } }),
      'gmail',
    )
    expect(args).toEqual({ toolkit: 'gmail', action: 'INITIATE_CONNECTION' })
  })

  it('refuses when the action enum has nothing that starts a connection', () => {
    const out = buildLinkArgs(
      schema({ toolkit: { type: 'string' }, action: { enum: ['list', 'rename'] } }),
      'gmail',
    )
    expect(isRefusal(out)).toBe(true)
    if (isRefusal(out)) expect(out.reason).toContain('list, rename')
  })

  it('refuses when no field names an app', () => {
    const out = buildLinkArgs(schema({ userId: { type: 'string' } }), 'gmail')
    expect(isRefusal(out)).toBe(true)
    if (isRefusal(out)) expect(out.reason).toContain('userId')
  })

  it('refuses when the tool publishes no arguments at all', () => {
    const out = buildLinkArgs({ type: 'object' }, 'gmail')
    expect(isRefusal(out)).toBe(true)
  })

  it('refuses rather than guessing a required field it cannot fill', () => {
    const out = buildLinkArgs(
      schema({ toolkit: { type: 'string' }, userId: { type: 'string' } }, ['toolkit', 'userId']),
      'gmail',
    )
    expect(isRefusal(out)).toBe(true)
    if (isRefusal(out)) expect(out.reason).toContain('userId')
  })

  it('does not refuse over an optional field it cannot fill', () => {
    const out = buildLinkArgs(
      schema({ toolkit: { type: 'string' }, alias: { type: 'string' } }, ['toolkit']),
      'gmail',
    )
    expect(isRefusal(out)).toBe(false)
  })
})

describe('approvalUrlFrom', () => {
  it('finds the link in a sentence', () => {
    expect(approvalUrlFrom('Open https://connect.composio.dev/link/ln_abc to approve.')).toBe(
      'https://connect.composio.dev/link/ln_abc',
    )
  })

  it('returns null when there is no link', () => {
    expect(approvalUrlFrom('Already connected.')).toBeNull()
  })

  it('refuses a non-http scheme, so a result cannot open something local', () => {
    expect(approvalUrlFrom('file:///etc/passwd')).toBeNull()
    expect(approvalUrlFrom('javascript:alert(1)')).toBeNull()
  })
})
