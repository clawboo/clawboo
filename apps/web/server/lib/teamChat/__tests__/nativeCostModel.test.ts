import { describe, expect, it } from 'vitest'

import { isLocalModel } from '../../costUtils'
import { nativeCostModel } from '../serverDeliver'

describe('nativeCostModel', () => {
  it('writes an Ollama model as ollama/<model>, so a failed local turn stays free', () => {
    const model = nativeCostModel({ primaryProvider: 'ollama', primaryModel: 'llama3.2' })
    expect(model).toBe('ollama/llama3.2')
    expect(isLocalModel(model)).toBe(true)
  })

  it("keeps an Ollama cloud model priced, and another provider's model as is", () => {
    expect(
      isLocalModel(
        nativeCostModel({ primaryProvider: 'ollama', primaryModel: 'gpt-oss:120b-cloud' }),
      ),
    ).toBe(false)
    expect(
      nativeCostModel({ primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-4-5' }),
    ).toBe('claude-sonnet-4-5')
  })

  it('is null for an agent with no stored config', () => {
    expect(nativeCostModel(null)).toBeNull()
  })
})
