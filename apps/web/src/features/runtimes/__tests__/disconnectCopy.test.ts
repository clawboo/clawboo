import { describe, expect, it } from 'vitest'

import { runtimeDisconnectMessage } from '../disconnectCopy'

describe('runtimeDisconnectMessage', () => {
  it('says a shared key stays, and names who else uses it', () => {
    expect(
      runtimeDisconnectMessage('Hermes', {
        removes: [],
        keeps: [{ envVar: 'OPENROUTER_API_KEY', sharedWith: ['Clawboo Native'] }],
      }),
    ).toBe(
      'Your OpenRouter key stays saved, because Clawboo Native uses it too. Hermes stops using them until you connect it again. To delete that key, disconnect it under Settings > Providers.',
    )
  })

  it('lists several kept keys with their runtimes, and Ollama when it is on', () => {
    expect(
      runtimeDisconnectMessage(
        'Clawboo Native',
        {
          removes: ['GEMINI_API_KEY', 'XAI_API_KEY'],
          keeps: [
            { envVar: 'ANTHROPIC_API_KEY', sharedWith: ['Claude Code', 'Hermes'] },
            { envVar: 'OPENAI_API_KEY', sharedWith: ['Hermes'] },
          ],
        },
        { ollama: true },
      ),
    ).toBe(
      'This deletes your saved Google and xAI keys. It turns off local Ollama. These keys stay saved, because other runtimes use them: Anthropic (Claude Code and Hermes), OpenAI (Hermes). Clawboo Native stops using them until you connect it again. To delete a kept key, disconnect it under Settings > Providers.',
    )
  })

  it('says nothing is deleted when no key is saved', () => {
    expect(runtimeDisconnectMessage('Claude Code', { removes: [], keeps: [] })).toBe(
      'No key is saved for Claude Code, so nothing is deleted. It stops using any key from your environment until you connect it again.',
    )
  })

  it('stays accurate without a plan', () => {
    expect(runtimeDisconnectMessage('Hermes', undefined)).toContain(
      'keeps any key another runtime also uses',
    )
  })
})
