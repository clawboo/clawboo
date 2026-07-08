// The native team-delegation SIGNAL tool — asserts it is signal-only (acks,
// never touches the board) and validates its args. The engine turning the
// emitted tool-call into a durable board task is covered by the cascade contract
// (packages/team-orchestration boardOrchestration.contract.test.ts).

import { describe, expect, it } from 'vitest'

import { buildDelegateTool } from '../delegateTool'

describe('native delegate tool', () => {
  const tool = buildDelegateTool()

  it('is named `delegate` with a required { assignee, task } schema', () => {
    expect(tool.name).toBe('delegate')
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['assignee', 'task'])
    expect((schema.required ?? []).slice().sort()).toEqual(['assignee', 'task'])
  })

  it('acks a valid delegation (signal-only — no error, echoes assignee + task)', async () => {
    const out = await tool.run({ assignee: 'Coder', task: 'add a README' })
    expect(out.isError).toBe(false)
    expect(out.output).toContain('Coder')
    expect(out.output).toContain('add a README')
  })

  it('rejects a missing / blank assignee or task', async () => {
    expect((await tool.run({ task: 'x' })).isError).toBe(true)
    expect((await tool.run({ assignee: 'Coder' })).isError).toBe(true)
    expect((await tool.run({ assignee: '   ', task: '   ' })).isError).toBe(true)
  })
})
