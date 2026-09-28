// One vocabulary for what an agent carries. The counts under a Boo, the group
// tiles, the tile names and the screen-reader names all read from here, so a
// word that drifts here drifts everywhere at once.

import { describe, expect, it } from 'vitest'

import {
  capabilityClassOf,
  capabilityCount,
  countOf,
  describeClassCounts,
  humanizeCapabilityName,
  isPluginRecord,
  pluginProviderId,
} from '../capabilityVocabulary'

describe('capabilityClassOf', () => {
  it('tells an OpenClaw plugin from a connector, although the Gateway reports both as connectors', () => {
    const plugin = {
      kind: 'connector',
      source: 'openclaw-extension',
      sourceKey: 'plugin:anthropic',
    }
    const gatewayServer = {
      kind: 'connector',
      source: 'openclaw-extension',
      sourceKey: 'mcp:github',
    }
    const spine = { kind: 'connector', source: 'mcp-connector', sourceKey: 'mcp:clawboo-memory' }

    expect(capabilityClassOf(plugin as never)).toBe('plugin')
    expect(isPluginRecord(plugin as never)).toBe(true)
    expect(capabilityClassOf(gatewayServer as never)).toBe('connector')
    expect(capabilityClassOf(spine as never)).toBe('connector')
  })

  it('keeps skills, tools and the built-in tool set apart', () => {
    expect(
      capabilityClassOf({ kind: 'skill', source: 'curated-skill', sourceKey: 'brainstorming' }),
    ).toBe('skill')
    expect(
      capabilityClassOf({
        kind: 'tool',
        source: 'openclaw-extension',
        sourceKey: 'sessions_spawn',
      }),
    ).toBe('tool')
    expect(
      capabilityClassOf({ kind: 'tool', source: 'runtime-builtin', sourceKey: 'builtins' }),
    ).toBe('builtin')
  })
})

describe('counting words', () => {
  it('agrees in number', () => {
    expect(countOf(1, 'plugin')).toBe('1 plugin')
    expect(countOf(41, 'plugin')).toBe('41 plugins')
    expect(capabilityCount(1)).toBe('1 capability')
    expect(capabilityCount(47)).toBe('47 capabilities')
  })

  it("lists what a person gave the agent first, and the runtime's tool set without a number", () => {
    expect(describeClassCounts({ plugin: 41, builtin: 1, skill: 1, connector: 3, tool: 2 })).toBe(
      '1 skill, 2 tools, 3 connectors, 41 plugins, built-in tools',
    )
    expect(describeClassCounts({})).toBe('')
  })
})

describe('humanizeCapabilityName', () => {
  it('turns an identifier into a name', () => {
    expect(humanizeCapabilityName('web_search')).toBe('Web Search')
    expect(humanizeCapabilityName('sessions_spawn')).toBe('Sessions Spawn')
    expect(humanizeCapabilityName('device-pair')).toBe('Device Pair')
    expect(humanizeCapabilityName('echo')).toBe('Echo')
  })

  it('spells acronyms and brands the way they are written', () => {
    expect(humanizeCapabilityName('tts-local-cli')).toBe('TTS Local CLI')
    expect(humanizeCapabilityName('github-copilot')).toBe('GitHub Copilot')
    expect(humanizeCapabilityName('lmstudio')).toBe('LM Studio')
    expect(humanizeCapabilityName('openai')).toBe('OpenAI')
    expect(humanizeCapabilityName('huggingface')).toBe('Hugging Face')
    expect(humanizeCapabilityName('xai')).toBe('xAI')
    expect(humanizeCapabilityName('openai-codex')).toBe('OpenAI Codex')
  })

  it('does not turn a word into a provider through an alias', () => {
    // "gemini" is an alias of Google for model routing, not a name to print.
    expect(humanizeCapabilityName('gemini-cli')).toBe('Gemini CLI')
  })

  it('leaves a name written for a person alone', () => {
    expect(humanizeCapabilityName('Brainstorming')).toBe('Brainstorming')
    expect(humanizeCapabilityName('Vendor MCP')).toBe('Vendor MCP')
    expect(humanizeCapabilityName('Chrome DevTools')).toBe('Chrome DevTools')
  })
})

describe('pluginProviderId', () => {
  it('finds the provider a plugin stands for, and only for plugins', () => {
    const plugin = (id: string) =>
      ({ kind: 'connector', source: 'openclaw-extension', sourceKey: `plugin:${id}` }) as never

    expect(pluginProviderId(plugin('anthropic'))).toBe('anthropic')
    expect(pluginProviderId(plugin('xai'))).toBe('xai')
    expect(pluginProviderId(plugin('device-pair'))).toBeNull()
    expect(
      pluginProviderId({
        kind: 'connector',
        source: 'mcp-connector',
        sourceKey: 'mcp:anthropic',
      }),
    ).toBeNull()
  })
})
