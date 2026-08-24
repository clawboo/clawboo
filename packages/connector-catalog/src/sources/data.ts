// Curated: data, search, and infrastructure connectors.
// Same verification rule as ./dev.ts: every package below resolved on npm and
// is pinned to the version that answered.

import type { ConnectorDefinition } from '../types'

export const DATA_CONNECTORS: ConnectorDefinition[] = [
  {
    slug: 'sqlite',
    displayName: 'SQLite',
    description: 'Query a local SQLite database and inspect its schema.',
    category: 'data',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server-sqlite-npx@0.8.0'],
      pinnedVersion: '0.8.0',
    },
    // Verified by running it: exits 1 with
    // `Usage: mcp-server-sqlite-npx <database-path>`. Nothing in the args looks
    // wrong, which is exactly why this has to be declared rather than detected.
    requiresUserArgument: true,
    userArgument: {
      label: 'SQLite database file',
      description: 'The .db file to query. It is opened directly, so it must already exist.',
      example: '/Users/you/data/app.db',
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: [],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: false },
    tags: ['sql', 'database', 'local', 'query'],
    homepage: 'https://www.npmjs.com/package/mcp-server-sqlite-npx',
  },
  {
    slug: 'supabase',
    displayName: 'Supabase',
    description: 'Query tables, inspect schema, and manage a Supabase project.',
    category: 'data',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@supabase/mcp-server-supabase@0.10.0'],
      pinnedVersion: '0.10.0',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'SUPABASE_ACCESS_TOKEN',
          description: 'A Supabase personal access token.',
          docsUrl: 'https://supabase.com/dashboard/account/tokens',
          required: true,
          secret: true,
        },
      ],
    },
    egressAllow: ['api.supabase.com', 'supabase.co'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: true },
    tags: ['database', 'postgres', 'backend'],
    homepage: 'https://github.com/supabase-community/supabase-mcp',
  },
  {
    slug: 'airtable',
    displayName: 'Airtable',
    description: 'Read and write Airtable bases, tables, and records.',
    category: 'data',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'airtable-mcp-server@1.14.0'],
      pinnedVersion: '1.14.0',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'AIRTABLE_API_KEY',
          description: 'An Airtable personal access token with base read/write scope.',
          docsUrl: 'https://airtable.com/create/tokens',
          required: true,
          secret: true,
        },
      ],
    },
    egressAllow: ['api.airtable.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['spreadsheet', 'records', 'database'],
    homepage: 'https://github.com/domdomegg/airtable-mcp-server',
  },
  {
    slug: 'exa',
    displayName: 'Exa Search',
    description: 'Neural web search that returns full page contents, not just links.',
    category: 'search',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'exa-mcp-server@3.4.0'],
      pinnedVersion: '3.4.0',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'EXA_API_KEY',
          description: 'An Exa API key.',
          docsUrl: 'https://dashboard.exa.ai/api-keys',
          required: true,
          secret: true,
        },
      ],
    },
    egressAllow: ['api.exa.ai'],
    // The whole point of this connector is to pull in pages an attacker may
    // author, so `ingestsUntrustedContent` is not a maybe.
    trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    tags: ['search', 'web', 'research'],
    homepage: 'https://github.com/exa-labs/exa-mcp-server',
  },
  {
    slug: 'memory',
    displayName: 'Knowledge Graph Memory',
    description: 'A persistent local knowledge graph the agent can write notes into.',
    category: 'data',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory@2026.7.4'],
      pinnedVersion: '2026.7.4',
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: [],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: false },
    tags: ['memory', 'knowledge-graph', 'notes'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'sequential-thinking',
    displayName: 'Sequential Thinking',
    description: 'A scratchpad tool for stepwise reasoning on hard problems.',
    category: 'productivity',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2026.7.4'],
      pinnedVersion: '2026.7.4',
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: [],
    trifecta: { readsPrivateData: false, ingestsUntrustedContent: false, canEgress: false },
    tags: ['reasoning', 'planning', 'scratchpad'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
]
