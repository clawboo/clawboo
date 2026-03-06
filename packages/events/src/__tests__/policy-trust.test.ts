import { describe, it, expect } from 'vitest'
import { decideTrustEvent } from '../policy/trust'
import type { ClassifiedEvent } from '../types'

function makeApprovalEvent(
  event: string,
  agentId: string | undefined,
  payload: unknown = {},
): ClassifiedEvent {
  return {
    kind: 'approval',
    agentId,
    payload,
    timestamp: Date.now(),
    raw: { type: 'event', event },
  }
}

describe('decideTrustEvent', () => {
  it('returns approvalPending for exec.approval.pending', () => {
    const event = makeApprovalEvent('exec.approval.pending', 'a1', {
      command: 'rm -rf /',
    })
    const intents = decideTrustEvent(event)
    expect(intents).toHaveLength(1)
    expect(intents[0].kind).toBe('approvalPending')
    if (intents[0].kind === 'approvalPending') {
      expect(intents[0].plane).toBe('trust')
      expect(intents[0].agentId).toBe('a1')
      expect(intents[0].payload).toEqual({ command: 'rm -rf /' })
    }
  })

  it('returns approvalResolved for exec.approval.resolved', () => {
    const event = makeApprovalEvent('exec.approval.resolved', 'a1', {
      resolution: 'allow',
    })
    const intents = decideTrustEvent(event)
    expect(intents).toHaveLength(1)
    expect(intents[0].kind).toBe('approvalResolved')
    if (intents[0].kind === 'approvalResolved') {
      expect(intents[0].plane).toBe('trust')
      expect(intents[0].agentId).toBe('a1')
      expect(intents[0].payload).toEqual({ resolution: 'allow' })
    }
  })

  it('returns approvalResolved for any non-pending approval event', () => {
    // decideTrustEvent only checks for 'exec.approval.pending' explicitly;
    // everything else (including 'exec.approval.resolved') falls through to approvalResolved
    const event = makeApprovalEvent('exec.approval.something_else', 'a1')
    const intents = decideTrustEvent(event)
    expect(intents[0].kind).toBe('approvalResolved')
  })

  it('returns ignore when agentId is missing', () => {
    const event = makeApprovalEvent('exec.approval.pending', undefined)
    const intents = decideTrustEvent(event)
    expect(intents).toHaveLength(1)
    expect(intents[0].kind).toBe('ignore')
    if (intents[0].kind === 'ignore') {
      expect(intents[0].reason).toContain('agentId')
    }
  })

  it('passes through the full payload', () => {
    const fullPayload = {
      agentId: 'a1',
      command: 'npm install',
      cwd: '/home/user',
      host: 'localhost',
    }
    const event = makeApprovalEvent('exec.approval.pending', 'a1', fullPayload)
    const intents = decideTrustEvent(event)
    if (intents[0].kind === 'approvalPending') {
      expect(intents[0].payload).toEqual(fullPayload)
    }
  })
})
