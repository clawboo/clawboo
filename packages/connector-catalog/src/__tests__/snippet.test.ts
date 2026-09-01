import { describe, expect, it } from 'vitest'

import {
  CONNECTOR_DEFINITIONS,
  connectorBySlug,
  connectorSnippet,
  SECRET_LOOKING_VALUE,
  SNIPPET_DIALECTS,
  type ConnectorDefinition,
} from '../index'

const filesystem = connectorBySlug('filesystem') as ConnectorDefinition
const github = connectorBySlug('github') as ConnectorDefinition
const notion = connectorBySlug('notion') as ConnectorDefinition

describe('connectorSnippet: stdio', () => {
  it('emits a Claude Code mcpServers block', () => {
    const s = connectorSnippet(filesystem, 'claude-code')
    expect(s.file).toBe('.mcp.json')
    expect(s.language).toBe('json')
    const parsed = JSON.parse(s.body) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>
    }
    expect(parsed.mcpServers['filesystem']?.type).toBe('stdio')
    expect(parsed.mcpServers['filesystem']?.command).toBe('npx')
    expect(parsed.mcpServers['filesystem']?.args).toContain(
      '@modelcontextprotocol/server-filesystem@2026.7.10',
    )
  })

  it('emits a Codex TOML block', () => {
    const s = connectorSnippet(filesystem, 'codex')
    expect(s.file).toBe('~/.codex/config.toml')
    expect(s.language).toBe('toml')
    expect(s.body).toContain('[mcp_servers.filesystem]')
    expect(s.body).toContain('command = "npx"')
  })

  it('uses .vscode/mcp.json for the VS Code dialect', () => {
    expect(connectorSnippet(filesystem, 'vscode').file).toBe('.vscode/mcp.json')
  })
})

describe('connectorSnippet: remote', () => {
  it('emits type:http with the url for Claude Code', () => {
    const parsed = JSON.parse(connectorSnippet(github, 'claude-code').body) as {
      mcpServers: Record<string, { type: string; url: string }>
    }
    expect(parsed.mcpServers['github']?.type).toBe('http')
    expect(parsed.mcpServers['github']?.url).toBe('https://api.githubcopilot.com/mcp/')
  })

  it('emits url= for Codex rather than refusing', () => {
    // transcoder.ts throws NonStdioUnsupportedError here; codexDriver.ts writes
    // exactly this block in production. The driver is the one that ships.
    const s = connectorSnippet(github, 'codex')
    expect(s.body).toContain('[mcp_servers.github]')
    expect(s.body).toContain('url = "https://api.githubcopilot.com/mcp/"')
  })
})

describe('credentials never enter a snippet', () => {
  it('interpolates env by NAME, never a value', () => {
    const s = connectorSnippet(notion, 'claude-code')
    expect(s.body).toContain('${NOTION_TOKEN}')
    expect(s.requiredEnv).toContain('NOTION_TOKEN')
  })

  it('lists required env for the Codex dialect too', () => {
    const s = connectorSnippet(notion, 'codex')
    expect(s.body).toContain('env_vars = ["NOTION_TOKEN"]')
  })

  it('omits the env block entirely for a no-auth connector', () => {
    const parsed = JSON.parse(connectorSnippet(filesystem, 'claude-code').body) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(parsed.mcpServers['filesystem']).not.toHaveProperty('env')
    expect(connectorSnippet(filesystem, 'claude-code').requiredEnv).toEqual([])
  })
})

describe('every catalog entry × every dialect', () => {
  it('produces a parseable, non-empty snippet', () => {
    for (const def of CONNECTOR_DEFINITIONS) {
      for (const { id } of SNIPPET_DIALECTS) {
        const s = connectorSnippet(def, id)
        expect(s.body.length, `${def.slug}/${id}`).toBeGreaterThan(0)
        if (s.language === 'json') {
          expect(() => JSON.parse(s.body), `${def.slug}/${id}`).not.toThrow()
        } else {
          expect(s.body, `${def.slug}/${id}`).toMatch(/^\[mcp_servers\./)
        }
      }
    }
  })

  it('never leaks a literal secret-looking value', () => {
    for (const def of CONNECTOR_DEFINITIONS) {
      for (const { id } of SNIPPET_DIALECTS) {
        const body = connectorSnippet(def, id).body
        // Anything that looks like a real token rather than a ${VAR} reference.
        expect(body, `${def.slug}/${id}`).not.toMatch(SECRET_LOOKING_VALUE)
      }
    }
  })

  it('the secret pattern catches the prefixes it is meant to', () => {
    // Guarding the guard. The previous pattern demanded eight straight
    // alphanumerics after `sk_`, so every Stripe key walked through it.
    for (const sample of [
      'sk_test_51H8xYzAbCdEfGhIj',
      'sk_live_51H8xYzAbCdEfGhIj',
      'sk-proj-AbCdEfGhIjKlMnOpQrSt',
      'xoxb-1234567890-abcdefghij',
      'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      'github_pat_11ABCDEFG0abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      expect(sample).toMatch(SECRET_LOOKING_VALUE)
    }
    // ...and does not fire on the things a real snippet is made of.
    for (const sample of [
      '${STRIPE_SECRET_KEY}',
      '@modelcontextprotocol/server-filesystem@2026.7.10',
      'https://mcp.stripe.com',
      '/path/to/allowed/dir',
    ]) {
      expect(sample).not.toMatch(SECRET_LOOKING_VALUE)
    }
  })
})

describe('tomlKey quoting', () => {
  it('quotes a dotted slug so it cannot become a nested table', () => {
    // `[mcp_servers.a.b]` would register a server named `b` under `a`.
    const dotted: ConnectorDefinition = {
      ...filesystem,
      slug: 'a.b',
    }
    expect(connectorSnippet(dotted, 'codex').body).toContain('[mcp_servers."a.b"]')
  })
})

describe('a bearer connector in every dialect', () => {
  // The block is copied into a file on the operator's disk, so it must reference
  // the token rather than contain it, and it must reference it in the form each
  // client actually substitutes.
  const github = connectorBySlug('github')!

  it('uses Codex’s bearer field, not a header it would treat as a literal', () => {
    // Codex reads `http_headers` values as literal strings, so
    // `Authorization = "Bearer ${GITHUB_TOKEN}"` would send that text to GitHub
    // verbatim. Codex's own migration tooling rewrites exactly that shape into
    // `bearer_token_env_var`, which is the field that reads the variable.
    const body = connectorSnippet(github, 'codex').body
    expect(body).toContain('bearer_token_env_var = "GITHUB_TOKEN"')
    expect(body).not.toContain('http_headers')
    expect(body).not.toContain('Bearer ${')
  })

  it('uses an Authorization header in the JSON dialects', () => {
    for (const dialect of ['claude-code', 'vscode'] as const) {
      const body = connectorSnippet(github, dialect).body
      expect(body, dialect).toContain('"Authorization": "Bearer ${GITHUB_TOKEN}"')
    }
  })
})
