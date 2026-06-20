// Per-runtime attach for the TeamChat server. The three CLI runtimes (Hermes /
// Codex / Claude) + OpenClaw all attach by looping MCP_SERVER_NAMES through the
// shared buildAttachConfig / mcpHttpUrl layer, so proving that layer carries
// 'teamchat' with the author binding proves every runtime auto-attaches it. The
// native runtime attaches in-process (covered by the apps/web bridge test).

import { describe, expect, it } from 'vitest'

import { buildAttachConfig, MCP_SERVER_NAMES, mcpHttpUrl } from '../config'

const scope = { teamId: 'tm1', agentId: 'boo-1' }

describe('TeamChat per-runtime attach (shared layer)', () => {
  it('teamchat is in MCP_SERVER_NAMES (so every per-runtime attach loop includes it)', () => {
    expect(MCP_SERVER_NAMES).toContain('teamchat')
  })

  it('mcpHttpUrl binds the room + author identity on the teamchat URL (anti-spoof)', () => {
    const url = mcpHttpUrl('http://localhost:18790', 'teamchat', scope)
    expect(url).toContain('/api/mcp/teamchat')
    expect(url).toContain('roomTeamId=tm1')
    expect(url).toContain('postAuthorAgentId=boo-1')
    // It must NOT leak the memory-scope param names.
    expect(url).not.toContain('scopeTeamId')
  })

  it('Claude Code inline mcpServers includes the bound clawboo-teamchat server', () => {
    const cfg = buildAttachConfig({
      runtime: 'claude-code',
      server: 'teamchat',
      transport: 'http',
      httpBaseUrl: 'http://localhost:18790',
      scope,
    })
    expect(cfg.id).toBe('clawboo-teamchat')
    const structured = cfg.structured as Record<string, { url: string }>
    expect(structured['clawboo-teamchat']?.url).toContain('roomTeamId=tm1')
  })

  it('Codex config.toml + OpenClaw Gateway config both carry the bound teamchat server', () => {
    const codex = buildAttachConfig({
      runtime: 'codex',
      server: 'teamchat',
      transport: 'http',
      httpBaseUrl: 'http://localhost:18790',
      scope,
    })
    expect(codex.snippet).toContain('[mcp_servers.clawboo-teamchat]')
    expect(codex.snippet).toContain('postAuthorAgentId=boo-1')

    const openclaw = buildAttachConfig({
      runtime: 'openclaw',
      server: 'teamchat',
      transport: 'http',
      httpBaseUrl: 'http://localhost:18790',
      scope,
    })
    expect((openclaw.structured as { url: string }).url).toContain('/api/mcp/teamchat')
  })
})
