// Folding the big read-only sets into one tile each.
//
// The fixture is the shape of a real OpenClaw agent: the Gateway's forty-one
// plugins, clawboo's three spine servers, the two Gateway tools clawboo denies,
// the built-in tool set, and one skill a person installed. Drawn a tile each, the
// plugins were most of the ring and, in Atlas, pushed the installed skill behind
// "+N more".

import type { CapabilityRecord } from '@clawboo/capability-registry'
import { describe, expect, it } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'

import { buildGraphElements, GROUP_MIN_MEMBERS } from '../useGraphData'
import type { BooNodeData, GraphNode, ResourceNodeData, SkillNodeData } from '../types'

const agent = (): AgentState => ({
  id: 'a1',
  name: 'Agent 1',
  status: 'idle',
  sessionKey: null,
  model: null,
  createdAt: null,
  streamingText: null,
  runId: null,
  lastSeenAt: null,
  teamId: 't1',
  execConfig: null,
  runtime: 'openclaw',
})

const team = (): Team => ({
  id: 't1',
  name: 'Team 1',
  icon: '🛠️',
  color: '#FBBF24',
  colorCollectionId: null,
  templateId: null,
  agentCount: 0,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: false,
})

// Shaped like what GET /api/capabilities serves, including the grant identity
// the server stamps on EVERY connector record. A fixture without it is how a
// fold rule that keyed on `connectorId` passed here and folded nothing live.
const record = (over: Partial<CapabilityRecord> & { sourceKey: string }): CapabilityRecord => ({
  id: `openclaw:${over.sourceKey}`,
  kind: 'connector',
  ...(over.kind === undefined || over.kind === 'connector'
    ? { connectorId: `conn:openclaw:openclaw:${over.sourceKey}` }
    : {}),
  runtime: 'openclaw',
  scope: 'global',
  agentId: null,
  source: 'openclaw-extension',
  manageability: 'runtime-of-record',
  name: over.sourceKey,
  description: '',
  availability: null,
  available: true,
  diagnostics: [],
  provenance: null,
  status: 'ready',
  tenantId: null,
  syncedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const plugin = (id: string, over: Partial<CapabilityRecord> = {}) =>
  record({ sourceKey: `plugin:${id}`, name: id, writable: false, ...over })

const PLUGIN_IDS = [
  'alibaba',
  'anthropic',
  'azure-speech',
  'bonjour',
  'browser',
  'canvas',
  'clawrouter',
  'copilot-proxy',
  'cua-computer',
  'deepgram',
  'device-pair',
  'document-extract',
  'elevenlabs',
  'fal',
  'file-transfer',
  'geolocation',
  'github-copilot',
  'google',
  'huggingface',
  'linux-node',
  'litellm',
  'lmstudio',
  'memory-core',
  'microsoft',
  'microsoft-foundry',
  'minimax',
  'nvidia',
  'ollama',
  'openai',
  'opencode-go',
  'openrouter',
  'perplexity',
  'runway',
  'senseaudio',
  'sglang',
  'talk-voice',
  'together',
  'tts-local-cli',
  'vllm',
  'web-readability',
  'xai',
]

function openclawAgentCaps(): CapabilityRecord[] {
  return [
    ...PLUGIN_IDS.map((id) => plugin(id)),
    ...['clawboo-memory', 'clawboo-tasks', 'clawboo-tools'].map((name) =>
      record({ sourceKey: `mcp:${name}`, name, source: 'mcp-connector' }),
    ),
    record({
      sourceKey: 'sessions_spawn',
      name: 'sessions_spawn',
      kind: 'tool',
      status: 'disabled',
    }),
    record({
      sourceKey: 'sessions_yield',
      name: 'sessions_yield',
      kind: 'tool',
      status: 'disabled',
    }),
    record({
      sourceKey: 'builtins',
      name: 'Built-in tools',
      kind: 'tool',
      source: 'runtime-builtin',
      manageability: 'observe-only',
    }),
    record({
      sourceKey: 'brainstorming',
      name: 'Brainstorming',
      kind: 'skill',
      source: 'curated-skill',
      scope: 'agent',
      agentId: 'a1',
      manageability: 'managed',
    }),
  ]
}

function build(caps: CapabilityRecord[], scope: 'team' | 'atlas' = 'team') {
  return buildGraphElements(
    [agent()],
    new Map([['a1', { capabilities: caps, agentsMd: null }]]),
    [team()],
    null,
    null,
    null,
    scope,
  )
}

const skillData = (nodes: GraphNode[]) =>
  nodes.filter((n) => n.type === 'skill').map((n) => n.data as SkillNodeData)
const resourceData = (nodes: GraphNode[]) =>
  nodes.filter((n) => n.type === 'resource').map((n) => n.data as ResourceNodeData)

describe('folding read-only sets into one tile', () => {
  it("folds a Gateway's plugins into one tile and keeps everything with an action on its own", () => {
    const { rawNodes, rawEdges } = build(openclawAgentCaps())

    const group = rawNodes.find((n) => n.id === 'skill-a1-group-plugin')
    expect(group).toBeDefined()
    const data = group!.data as SkillNodeData
    expect(data.name).toBe('41 plugins')
    expect(data.group?.members).toHaveLength(41)
    expect(data.group?.runtime).toBe('openclaw')
    expect(data.installable).toBe(false)

    // No plugin is left as a tile of its own.
    expect(resourceData(rawNodes).filter((d) => d.serviceKind === 'plugin')).toHaveLength(0)
    // The spine servers carry toolbars and stay separate.
    expect(resourceData(rawNodes).map((d) => d.name)).toEqual(['Memory', 'Tasks', 'Tools'])
    // The skill a person installed stays separate, installable, with its own edge.
    const skill = skillData(rawNodes).find((d) => d.name === 'Brainstorming')
    expect(skill?.installable).toBe(true)

    // The group's edge is violet like its members, and offers nothing to remove.
    const edge = rawEdges.find((e) => e.id === 'skilledge-a1-group-plugin')
    expect(edge?.source).toBe('boo-a1')
    expect(edge?.data).toEqual({ accent: 'var(--violet)' })
  })

  it('lists members by readable name, with their providers and their state', () => {
    const caps = openclawAgentCaps().map((c) =>
      c.sourceKey === 'plugin:device-pair' ? { ...c, status: 'disabled' as const } : c,
    )
    const { rawNodes } = build(caps)
    const members = (rawNodes.find((n) => n.id === 'skill-a1-group-plugin')!.data as SkillNodeData)
      .group!.members

    expect(members.map((m) => m.name).slice(0, 3)).toEqual(['Alibaba', 'Anthropic', 'Azure Speech'])
    expect(members.find((m) => m.name === 'Anthropic')?.providerId).toBe('anthropic')
    expect(members.find((m) => m.name === 'Hugging Face')?.providerId).toBe('huggingface')
    expect(members.find((m) => m.name === 'Device Pair')).toEqual({
      name: 'Device Pair',
      state: 'off',
    })
  })

  it('stops pushing an installed skill behind "+N more" in Atlas', () => {
    const { rawNodes } = build(openclawAgentCaps(), 'atlas')
    const skills = skillData(rawNodes)

    expect(skills.some((d) => d.overflowCount)).toBe(false)
    expect(skills.some((d) => d.name === 'Brainstorming')).toBe(true)
  })

  it('keeps a small set as separate tiles, with readable names and provider marks', () => {
    const caps = [plugin('anthropic'), plugin('device-pair'), plugin('tts-local-cli')]
    expect(caps.length).toBeLessThan(GROUP_MIN_MEMBERS)
    const { rawNodes } = build(caps)
    const tiles = resourceData(rawNodes)

    expect(rawNodes.some((n) => n.id.includes('-group-'))).toBe(false)
    expect(tiles.map((d) => d.name)).toEqual(['Anthropic', 'Device Pair', 'TTS Local CLI'])
    expect(tiles.every((d) => d.serviceKind === 'plugin')).toBe(true)
    expect(tiles.find((d) => d.name === 'Anthropic')?.providerId).toBe('anthropic')
    expect(tiles.find((d) => d.name === 'Device Pair')?.providerId).toBeUndefined()
    // The raw id survives for the tooltip.
    expect(tiles.find((d) => d.name === 'Device Pair')?.fullName).toBe('device-pair')
  })

  it('never folds a tile that needs a person, or one backed by a grant', () => {
    const caps = [
      ...PLUGIN_IDS.slice(0, 6).map((id) => plugin(id)),
      plugin('perplexity', { health: 'needs-auth' }),
      plugin('runway', { grantId: 'g1' }),
    ]
    const { rawNodes } = build(caps)

    const group = rawNodes.find((n) => n.id === 'skill-a1-group-plugin')!.data as SkillNodeData
    expect(group.group?.members).toHaveLength(6)
    expect(resourceData(rawNodes).map((d) => d.name)).toEqual(['Perplexity', 'Runway'])
  })

  it('folds a large tool set, and greys a group only when nothing inside can run', () => {
    const tools = Array.from({ length: GROUP_MIN_MEMBERS }, (_, i) =>
      record({ sourceKey: `tool_${i}`, name: `tool_${i}`, kind: 'tool', status: 'disabled' }),
    )
    const { rawNodes, rawEdges } = build(tools)

    const group = rawNodes.find((n) => n.id === 'skill-a1-group-tool')!.data as SkillNodeData
    expect(group.name).toBe(`${GROUP_MIN_MEMBERS} tools`)
    expect(group.enabled).toBe(false)
    // Tools keep the mint accent, which SkillEdge falls back to without one.
    expect(rawEdges.find((e) => e.id === 'skilledge-a1-group-tool')?.data).toEqual({})
  })

  it('counts a group cut by the Atlas ceiling as every member it hides', () => {
    const caps = [
      ...Array.from({ length: 30 }, (_, i) =>
        record({
          sourceKey: `s${i}`,
          name: `Skill ${i}`,
          kind: 'skill',
          source: 'curated-skill',
          scope: 'agent',
          agentId: 'a1',
        }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        record({ sourceKey: `t${i}`, name: `t${i}`, kind: 'tool', source: 'brokered-mcp' }),
      ),
    ]
    const { rawNodes } = build(caps, 'atlas')
    const more = skillData(rawNodes).find((d) => d.overflowCount)

    // 24 skills shown; 6 skills and the 6-tool group cut.
    expect(more?.overflowCount).toBe(12)
  })
})

describe('the counts on a Boo', () => {
  it('count what the agent has, by kind, rather than the tiles drawn', () => {
    const { rawNodes } = build(openclawAgentCaps(), 'atlas')
    const boo = rawNodes.find((n) => n.id === 'boo-a1')!.data as BooNodeData

    expect(boo.ringCounts).toEqual({
      capabilities: 48,
      routes: 0,
      byClass: { plugin: 41, connector: 3, tool: 2, builtin: 1, skill: 1 },
    })
  })

  it('shows a readable name on a tile without changing the name installs use', () => {
    const { rawNodes } = build([
      record({ sourceKey: 'web_search', name: 'web_search', kind: 'tool', source: 'brokered-mcp' }),
    ])
    const tile = skillData(rawNodes).find((d) => d.name === 'web_search')

    expect(tile?.displayName).toBe('Web Search')
  })
})
