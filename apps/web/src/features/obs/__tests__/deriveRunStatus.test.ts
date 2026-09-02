// The fold that makes the graph alive during board runs. Board runs have no
// chat stream and no Gateway socket, so if this stops producing 'running' the
// Boos go dark for the exact window the work happens — the failure this exists
// to prevent, and one no other test would catch.

import { describe, expect, it } from 'vitest'

import { deriveAgentActivity } from '../deriveAgentActivity'
import { deriveRunStatus } from '../deriveRunStatus'
import type { ObsLogEvent } from '../useObsStream'

let seq = 0
function ev(partial: Partial<ObsLogEvent> & { kind: string }): ObsLogEvent {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    ts: 1_700_000_000_000 + seq * 1000,
    teamId: null,
    taskId: null,
    agentId: null,
    runtime: null,
    traceId: null,
    data: {},
    ...partial,
  }
}

describe('deriveRunStatus', () => {
  it('reports an agent running from execution_started', () => {
    const out = deriveRunStatus([ev({ kind: 'execution_started', agentId: 'a1' })])
    expect(out.get('a1')).toBe('running')
  })

  it('takes the LAST execution event, so a finished run does not read as running', () => {
    const out = deriveRunStatus([
      ev({ kind: 'execution_started', agentId: 'a1' }),
      ev({ kind: 'execution_completed', agentId: 'a1', data: { status: 'succeeded' } }),
    ])
    expect(out.get('a1')).toBe('idle')
  })

  it('reads a re-run after a completion as running again', () => {
    const out = deriveRunStatus([
      ev({ kind: 'execution_started', agentId: 'a1' }),
      ev({ kind: 'execution_completed', agentId: 'a1', data: { status: 'succeeded' } }),
      ev({ kind: 'execution_started', agentId: 'a1' }),
    ])
    expect(out.get('a1')).toBe('running')
  })

  it('maps a failed completion to error, case-insensitively', () => {
    for (const status of ['failed', 'FAILED', 'error', 'crashed']) {
      const out = deriveRunStatus([
        ev({ kind: 'execution_completed', agentId: 'a1', data: { status } }),
      ])
      expect(out.get('a1'), status).toBe('error')
    }
  })

  it('treats an unknown or missing completion status as a clean finish', () => {
    expect(
      deriveRunStatus([ev({ kind: 'execution_completed', agentId: 'a1', data: {} })]).get('a1'),
    ).toBe('idle')
  })

  it('tracks agents independently', () => {
    const out = deriveRunStatus([
      ev({ kind: 'execution_started', agentId: 'a1' }),
      ev({ kind: 'execution_started', agentId: 'a2' }),
      ev({ kind: 'execution_completed', agentId: 'a2', data: { status: 'succeeded' } }),
    ])
    expect(out.get('a1')).toBe('running')
    expect(out.get('a2')).toBe('idle')
  })

  it('is EVIDENCE-ONLY: an agent with no execution event is absent, never idle', () => {
    // The caller patches only what this returns. Defaulting absent agents to
    // idle would clobber a live CHAT run, whose status is written by a different
    // path entirely and which emits no execution events.
    const out = deriveRunStatus([
      ev({ kind: 'tool_call', agentId: 'chatty' }),
      ev({ kind: 'execution_started', agentId: 'a1' }),
    ])
    expect(out.has('chatty')).toBe(false)
    expect(out.size).toBe(1)
  })

  it('ignores rows with no agentId', () => {
    expect(deriveRunStatus([ev({ kind: 'execution_started' })]).size).toBe(0)
  })
})

describe('deriveAgentActivity', () => {
  const toolCall = (agentId: string, name: string, input: Record<string, unknown>): ObsLogEvent =>
    ev({ kind: 'tool_call', agentId, data: { toolCallId: `t${seq}`, name, input } })

  it('reports the file an agent is editing, by basename', () => {
    const out = deriveAgentActivity([
      toolCall('a1', 'Edit', { file_path: '/repo/src/pricing.css' }),
    ])
    expect(out.get('a1')).toBe('editing pricing.css')
  })

  it('reports a shell command as-is', () => {
    const out = deriveAgentActivity([toolCall('a1', 'Bash', { command: 'pnpm test' })])
    expect(out.get('a1')).toBe('pnpm test')
  })

  it('prefers whichever happened most recently', () => {
    const fileFirst = deriveAgentActivity([
      toolCall('a1', 'Edit', { file_path: '/repo/a.ts' }),
      toolCall('a1', 'Bash', { command: 'pnpm build' }),
    ])
    expect(fileFirst.get('a1')).toBe('pnpm build')

    const commandFirst = deriveAgentActivity([
      toolCall('a2', 'Bash', { command: 'pnpm build' }),
      toolCall('a2', 'Edit', { file_path: '/repo/b.ts' }),
    ])
    expect(commandFirst.get('a2')).toBe('editing b.ts')
  })

  it('keeps each agent on its own line', () => {
    const out = deriveAgentActivity([
      toolCall('a1', 'Edit', { file_path: '/repo/one.ts' }),
      toolCall('a2', 'Edit', { file_path: '/repo/two.ts' }),
    ])
    expect(out.get('a1')).toBe('editing one.ts')
    expect(out.get('a2')).toBe('editing two.ts')
  })

  it('collapses whitespace and truncates a long command so a card cannot wrap forever', () => {
    const out = deriveAgentActivity([
      toolCall('a1', 'Bash', { command: `pnpm  run\n   ${'x'.repeat(120)}` }),
    ])
    const line = out.get('a1') ?? ''
    expect(line.length).toBeLessThanOrEqual(48)
    expect(line.endsWith('…')).toBe(true)
    expect(line).not.toContain('\n')
  })

  it('omits an agent with no tool activity, so a live chat line is never blanked', () => {
    const out = deriveAgentActivity([ev({ kind: 'execution_started', agentId: 'a1' })])
    expect(out.has('a1')).toBe(false)
  })
})
