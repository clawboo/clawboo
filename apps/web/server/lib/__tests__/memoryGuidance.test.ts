// Per-runtime MEMORY_GUIDANCE: names the runtime's PRIVATE native memory
// and points durable team facts at the shared clawboo memory tool.

import { describe, expect, it } from 'vitest'

import { buildMemoryGuidance } from '../memoryGuidance'

describe('buildMemoryGuidance', () => {
  it('always names the shared clawboo memory tool', () => {
    for (const id of ['hermes', 'claude-code', 'codex', 'clawboo-native', 'something-else']) {
      const g = buildMemoryGuidance(id, true)
      expect(g).toContain('memory_save')
      expect(g.toLowerCase()).toContain('shared team memory')
    }
  })

  it('names the runtime-specific private store', () => {
    expect(buildMemoryGuidance('hermes', true)).toContain('MEMORY.md')
    expect(buildMemoryGuidance('claude-code', true)).toContain('memory:project')
    expect(buildMemoryGuidance('clawboo-native', true)).toContain('private memory store')
  })

  it('returns empty when there is no shared memory surface (no MCP base URL)', () => {
    expect(buildMemoryGuidance('hermes', false)).toBe('')
  })
})
