import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openclawAgentModel } from '../openclawAgentModel'

describe('openclawAgentModel', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-ocmodel-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (config: unknown): void =>
    writeFileSync(path.join(dir, 'openclaw.json'), JSON.stringify(config))

  it("reads the agent's own model before the default", () => {
    write({
      agents: {
        defaults: { model: { primary: 'anthropic/claude-sonnet-4-6' } },
        list: [{ id: 'writer', model: 'ollama/llama3.2' }, { id: 'coder' }],
      },
    })
    expect(openclawAgentModel('writer', dir)).toBe('ollama/llama3.2')
    expect(openclawAgentModel('coder', dir)).toBe('anthropic/claude-sonnet-4-6')
    expect(openclawAgentModel(null, dir)).toBe('anthropic/claude-sonnet-4-6')
  })

  it('takes a model given as an object with a primary ref', () => {
    write({ agents: { list: [{ id: 'writer', model: { primary: 'ollama/qwen2.5:7b' } }] } })
    expect(openclawAgentModel('writer', dir)).toBe('ollama/qwen2.5:7b')
  })

  it('is null when there is no config, or no model in it', () => {
    expect(openclawAgentModel('writer', dir)).toBeNull()
    write({ gateway: {} })
    expect(openclawAgentModel('writer', dir)).toBeNull()
    writeFileSync(path.join(dir, 'openclaw.json'), '{ not json')
    expect(openclawAgentModel('writer', dir)).toBeNull()
  })
})
