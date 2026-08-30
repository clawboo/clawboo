// Keeping the context window the runtime's own catalog already told us.
//
// `CliModel.contextWindow` was declared and then dropped by the transform that
// builds the model picker, which only needs an id and a label. That discarded
// number is what a runtime uses to decide it is running out of room, and losing
// it is how an agent came to compact against 32,768 tokens (its model's max
// OUTPUT tokens) when the model's real window was 204,800.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('node:util', () => ({
  promisify:
    () =>
    (...args: unknown[]) =>
      execFileMock(...args),
}))

const CLI = {
  count: 3,
  models: [
    {
      key: 'openrouter/minimax/minimax-m2.5',
      name: 'MiniMax M2.5',
      input: '',
      contextWindow: 204800,
      local: false,
      available: true,
      tags: [],
    },
    {
      key: 'ollama/llama3.2',
      name: 'Llama 3.2',
      input: '',
      contextWindow: 2048,
      local: true,
      available: true,
      tags: [],
    },
    // A catalog entry with no usable window. It must stay unresolvable.
    {
      key: 'weird/unknown-model',
      name: 'Unknown',
      input: '',
      contextWindow: 0,
      local: false,
      available: true,
      tags: [],
    },
  ],
}

beforeEach(() => {
  vi.resetModules()
  execFileMock.mockReset()
  execFileMock.mockResolvedValue({ stdout: JSON.stringify(CLI), stderr: '' })
})

describe('getContextWindowFromCli', () => {
  it('returns the window for the model that actually deadlocked', async () => {
    const { getContextWindowFromCli } = await import('../modelCache')
    // 204,800, not 32,768. The second number is the model's max output tokens,
    // and mistaking one for the other is the whole bug.
    expect(await getContextWindowFromCli('openrouter/minimax/minimax-m2.5')).toBe(204800)
  })

  it('returns a small local window honestly rather than a comfortable default', async () => {
    const { getContextWindowFromCli } = await import('../modelCache')
    expect(await getContextWindowFromCli('ollama/llama3.2')).toBe(2048)
  })

  it('returns null for a model the catalog does not know', async () => {
    // Null must stay null. A default invented here would be written into a
    // runtime's budget and believed, which is the failure being prevented.
    const { getContextWindowFromCli } = await import('../modelCache')
    expect(await getContextWindowFromCli('nothing/at-all')).toBeNull()
  })

  it('treats a zero or missing window as unknown, not as zero', async () => {
    const { getContextWindowFromCli } = await import('../modelCache')
    expect(await getContextWindowFromCli('weird/unknown-model')).toBeNull()
  })

  it('does not re-run the CLI once the cache is warm', async () => {
    // This is called on a config write; it must not spawn a process per lookup.
    const { getContextWindowFromCli } = await import('../modelCache')
    await getContextWindowFromCli('ollama/llama3.2')
    await getContextWindowFromCli('openrouter/minimax/minimax-m2.5')
    await getContextWindowFromCli('nothing/at-all')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('reports unknown rather than throwing when the CLI is unavailable', async () => {
    execFileMock.mockRejectedValue(new Error('openclaw: command not found'))
    const { getContextWindowFromCli } = await import('../modelCache')
    expect(await getContextWindowFromCli('ollama/llama3.2')).toBeNull()
  })

  it('still builds the model picker groups, unchanged', async () => {
    // The window is kept ALONGSIDE the existing transform, not instead of it.
    const { getModelsFromCli } = await import('../modelCache')
    const groups = await getModelsFromCli()
    expect(groups?.flatMap((g) => g.models).map((m) => m.id)).toContain(
      'openrouter/minimax/minimax-m2.5',
    )
  })
})
