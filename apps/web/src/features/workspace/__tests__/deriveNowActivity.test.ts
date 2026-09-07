// The now-line derivation is pure and runtime-shape-tolerant by design: tool
// inputs differ across the five runtimes, and a shape this misses must degrade
// to "no activity", never to a wrong path. These tests pin the extraction
// keys, the newest-first scan, and the workspace-relative fallback rules.

import { describe, expect, it } from 'vitest'

import type { ObsLogEvent } from '@/features/obs/useObsStream'
import { deriveNowActivity, toWorkspaceRelPath } from '../deriveNowActivity'

let seq = 0
function ev(kind: string, data: Record<string, unknown>): ObsLogEvent {
  seq++
  return {
    id: `e${seq}`,
    seq,
    ts: 1000 + seq,
    kind,
    teamId: null,
    taskId: null,
    agentId: 'a1',
    runtime: null,
    traceId: null,
    data,
  }
}

describe('deriveNowActivity', () => {
  it('returns nulls for an empty tail', () => {
    expect(deriveNowActivity([])).toEqual({ file: null, command: null })
  })

  it('picks the newest file-bearing and command-bearing tool calls', () => {
    const events = [
      ev('tool_call', { name: 'Edit', input: { file_path: '/w/old.ts' } }),
      ev('tool_call', { name: 'Bash', input: { command: 'pnpm test' } }),
      ev('tool_call', { name: 'Write', input: { file_path: '/w/new.ts' } }),
    ]
    const now = deriveNowActivity(events)
    expect(now.file?.path).toBe('/w/new.ts')
    expect(now.file?.tool).toBe('Write')
    expect(now.command?.command).toBe('pnpm test')
    expect(now.command?.tool).toBe('Bash')
  })

  it('reads alternative path keys used by other runtimes', () => {
    for (const key of ['path', 'filePath', 'notebook_path']) {
      const now = deriveNowActivity([ev('tool_call', { name: 't', input: { [key]: 'x.ts' } })])
      expect(now.file?.path).toBe('x.ts')
    }
  })

  it('reads cmd as a command key', () => {
    const now = deriveNowActivity([ev('tool_call', { name: 't', input: { cmd: 'ls' } })])
    expect(now.command?.command).toBe('ls')
  })

  it('ignores non-tool_call kinds and malformed inputs', () => {
    const events = [
      ev('tool_call', { name: 'Edit', input: { file_path: 'keep.ts' } }),
      ev('tool_result', { name: 'Edit', output: 'file_path: red-herring' }),
      ev('tool_call', { name: 'Odd', input: 'not-an-object' }),
      ev('tool_call', { name: 'Odd2', input: { file_path: 42 } }),
      ev('cost', { costUsd: 1 }),
    ]
    const now = deriveNowActivity(events)
    expect(now.file?.path).toBe('keep.ts')
  })

  it('one call can fill both slots', () => {
    const now = deriveNowActivity([
      ev('tool_call', { name: 'Run', input: { file_path: 'a.py', command: 'python a.py' } }),
    ])
    expect(now.file?.path).toBe('a.py')
    expect(now.command?.command).toBe('python a.py')
  })
})

describe('toWorkspaceRelPath', () => {
  it('passes a relative path through', () => {
    expect(toWorkspaceRelPath('src/a.ts', '/w/root')).toBe('src/a.ts')
  })

  it('relativizes an absolute path inside the workspace', () => {
    expect(toWorkspaceRelPath('/w/root/src/a.ts', '/w/root')).toBe('src/a.ts')
  })

  it('returns null for an absolute path outside the workspace', () => {
    expect(toWorkspaceRelPath('/elsewhere/x.ts', '/w/root')).toBeNull()
  })

  it('a prefix cousin of the root does not relativize', () => {
    expect(toWorkspaceRelPath('/w/root-evil/x.ts', '/w/root')).toBeNull()
  })

  it('returns null for an absolute path with no known root', () => {
    expect(toWorkspaceRelPath('/w/root/a.ts', null)).toBeNull()
  })
})

describe('ambiguous path key', () => {
  it('accepts a bare path when nothing search-shaped sits beside it', () => {
    const now = deriveNowActivity([ev('tool_call', { name: 'Read', input: { path: 'a.ts' } })])
    expect(now.file?.path).toBe('a.ts')
  })

  it('ignores a bare path on a search call, which names a directory', () => {
    for (const sibling of ['pattern', 'glob', 'query', 'output_mode']) {
      const now = deriveNowActivity([
        ev('tool_call', { name: 'Grep', input: { path: 'packages/', [sibling]: 'x' } }),
      ])
      expect(now.file).toBeNull()
    }
  })

  it('a search call does not outrank the real edited file', () => {
    const now = deriveNowActivity([
      ev('tool_call', { name: 'Edit', input: { file_path: 'src/real.ts' } }),
      ev('tool_call', { name: 'Grep', input: { path: 'packages/', pattern: 'foo' } }),
    ])
    expect(now.file?.path).toBe('src/real.ts')
  })

  it('file_path still wins over a sibling pattern on the same call', () => {
    const now = deriveNowActivity([
      ev('tool_call', { name: 'Odd', input: { file_path: 'x.ts', pattern: 'p' } }),
    ])
    expect(now.file?.path).toBe('x.ts')
  })
})
