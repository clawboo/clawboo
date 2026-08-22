// Curated: developer + coordination connectors.
//
// Every entry below was resolved against the live npm registry (stdio) or dialed
// (remote) while writing it, and pinned to the version that answered. Nothing in
// this file is aspirational: an entry whose package or endpoint could not be
// verified was left out rather than guessed at, because a directory that lists a
// connector which does not install is worse than a shorter directory.
//
// Remote entries were confirmed to return HTTP 401 to an unauthenticated
// `initialize` — which is the MCP authorization spec working as designed, and is
// the signal that OAuth discovery will have something to discover.

import type { ConnectorDefinition } from '../types'

export const DEV_CONNECTORS: ConnectorDefinition[] = [
  {
    slug: 'github',
    displayName: 'GitHub',
    description: 'Read and write issues, pull requests, and repository contents.',
    category: 'dev',
    provenance: 'curated',
    launch: { transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' },
    auth: {
      kind: 'oauth',
      inputs: [],
      scopes: ['repo', 'read:org'],
      scopesRationale:
        'Repository access to read and file issues and pull requests; org read to resolve team mentions.',
      setupGuide: {
        console: 'GitHub',
        url: 'https://github.com/settings/installations',
        steps: [
          'Approve the authorization request in the browser tab that opens.',
          'Choose which organizations and repositories to grant, not "all repositories".',
          'Return to clawboo — the connector tile clears its amber key badge on success.',
        ],
      },
    },
    egressAllow: ['api.githubcopilot.com', 'api.github.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['git', 'issues', 'pull-requests', 'code-review'],
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    slug: 'linear',
    displayName: 'Linear',
    description: 'Read and update Linear issues, projects, and cycles.',
    category: 'issues',
    provenance: 'curated',
    launch: { transport: 'streamable-http', url: 'https://mcp.linear.app/mcp' },
    auth: {
      kind: 'oauth',
      inputs: [],
      scopesRationale: 'Linear grants issue and project access through its own consent screen.',
      setupGuide: {
        console: 'Linear',
        url: 'https://linear.app/settings/api',
        steps: [
          'Approve the authorization request in the browser tab that opens.',
          'Pick the workspace this agent should act in.',
          'Return to clawboo — the tile clears its amber key badge on success.',
        ],
      },
    },
    egressAllow: ['mcp.linear.app', 'api.linear.app'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['issues', 'planning', 'tickets', 'project-management'],
    homepage: 'https://linear.app/docs/mcp',
  },
  {
    slug: 'sentry',
    displayName: 'Sentry',
    description: 'Inspect errors, issues, and stack traces from Sentry.',
    category: 'observability',
    provenance: 'curated',
    launch: { transport: 'streamable-http', url: 'https://mcp.sentry.dev/mcp' },
    auth: {
      kind: 'oauth',
      inputs: [],
      scopesRationale: 'Read access to the projects whose errors this agent should triage.',
      setupGuide: {
        console: 'Sentry',
        url: 'https://sentry.io/settings/',
        steps: [
          'Approve the authorization request in the browser tab that opens.',
          'Select the organization whose issues this agent may read.',
          'Return to clawboo — the tile clears its amber key badge on success.',
        ],
      },
    },
    egressAllow: ['mcp.sentry.dev', 'sentry.io'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['errors', 'monitoring', 'stack-traces', 'triage'],
    homepage: 'https://docs.sentry.io/product/sentry-mcp/',
  },
  {
    slug: 'sentry-local',
    displayName: 'Sentry (local)',
    description: 'Same Sentry tools, run as a local process with your own auth token.',
    category: 'observability',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@sentry/mcp-server@0.37.0'],
      pinnedVersion: '0.37.0',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'SENTRY_AUTH_TOKEN',
          description: 'A Sentry user auth token with project read scope.',
          docsUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
          required: true,
          secret: true,
        },
      ],
    },
    egressAllow: ['sentry.io'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['errors', 'monitoring', 'self-hosted'],
    homepage: 'https://www.npmjs.com/package/@sentry/mcp-server',
  },
  {
    slug: 'playwright',
    displayName: 'Playwright',
    description: 'Drive a real browser: navigate, click, fill forms, and read the page.',
    category: 'browser',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.79'],
      pinnedVersion: '0.0.79',
    },
    auth: { kind: 'none', inputs: [] },
    // Deliberately broad: a browser can reach anything. The egress allowlist is
    // not a meaningful control here, so the connector is honest about it rather
    // than shipping a list that implies containment it does not provide.
    egressAllow: ['*'],
    trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    tags: ['browser', 'automation', 'testing', 'scraping'],
    homepage: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    slug: 'chrome-devtools',
    displayName: 'Chrome DevTools',
    description: 'Inspect a running page: console, network, performance traces.',
    category: 'browser',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@1.7.0'],
      pinnedVersion: '1.7.0',
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: ['*'],
    trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    tags: ['browser', 'debugging', 'performance', 'devtools'],
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
  {
    slug: 'context7',
    displayName: 'Context7',
    description: 'Pull up-to-date documentation and code examples for a library.',
    category: 'docs',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@4.0.2'],
      pinnedVersion: '4.0.2',
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: ['context7.com', 'mcp.context7.com'],
    trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    tags: ['docs', 'reference', 'libraries'],
    homepage: 'https://github.com/upstash/context7',
  },
  {
    slug: 'filesystem',
    displayName: 'Filesystem',
    description:
      'Read and write files under directories you explicitly allow. Replace the path in the config with the directory you want to expose.',
    category: 'dev',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      // The trailing path is REQUIRED, not decoration. This server accepts its
      // allowed directories either as argv or as MCP Roots, and its own docs are
      // explicit: started with neither, it throws during initialization. A
      // snippet a user pastes and cannot start is worse than no snippet, so the
      // block ships with a placeholder they are told to edit.
      args: ['-y', '@modelcontextprotocol/server-filesystem@2026.7.10', '/path/to/allowed/dir'],
      pinnedVersion: '2026.7.10',
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: [],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: false },
    tags: ['files', 'local', 'read', 'write'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'cloudflare',
    displayName: 'Cloudflare',
    description: 'Inspect and manage Workers, KV, R2, and DNS on your Cloudflare account.',
    category: 'dev',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@cloudflare/mcp-server-cloudflare@0.2.0'],
      pinnedVersion: '0.2.0',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'CLOUDFLARE_API_TOKEN',
          description: 'A scoped Cloudflare API token — not your global API key.',
          docsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
          required: true,
          secret: true,
        },
      ],
    },
    egressAllow: ['api.cloudflare.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: true },
    tags: ['cloudflare', 'workers', 'dns', 'deploy'],
    homepage: 'https://github.com/cloudflare/mcp-server-cloudflare',
  },
]
