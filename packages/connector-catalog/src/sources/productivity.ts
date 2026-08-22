// Curated: the SaaS canon — docs, chat, design, payments.
// Same verification rule as ./dev.ts.

import type { ConnectorDefinition } from '../types'

export const PRODUCTIVITY_CONNECTORS: ConnectorDefinition[] = [
  {
    slug: 'notion',
    displayName: 'Notion',
    description: 'Read and write Notion pages, databases, and comments.',
    category: 'docs',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server@2.5.1'],
      pinnedVersion: '2.5.1',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'NOTION_TOKEN',
          description: 'An internal integration token from your Notion workspace.',
          docsUrl: 'https://www.notion.so/my-integrations',
          required: true,
          secret: true,
        },
      ],
      setupGuide: {
        console: 'Notion Integrations',
        url: 'https://www.notion.so/my-integrations',
        steps: [
          'Create a new internal integration and copy its token.',
          'Open the pages or databases this agent should reach.',
          'Use the page menu to connect the integration — Notion grants nothing by default.',
        ],
      },
    },
    egressAllow: ['api.notion.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['docs', 'wiki', 'notes', 'database'],
    homepage: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    slug: 'slack',
    displayName: 'Slack',
    description: 'Read channel history and post messages to Slack.',
    category: 'chat',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack@2025.4.25'],
      pinnedVersion: '2025.4.25',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'SLACK_BOT_TOKEN',
          description: 'A Slack bot token (starts with xoxb-).',
          docsUrl: 'https://api.slack.com/apps',
          required: true,
          secret: true,
        },
        {
          key: 'SLACK_TEAM_ID',
          description: 'Your Slack workspace ID (starts with T).',
          required: true,
          secret: false,
        },
      ],
    },
    egressAllow: ['slack.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['chat', 'messaging', 'notifications'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'figma',
    displayName: 'Figma',
    description: 'Read Figma files, frames, and design tokens for implementation.',
    category: 'docs',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-developer-mcp@0.13.2'],
      pinnedVersion: '0.13.2',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'FIGMA_API_KEY',
          description: 'A Figma personal access token with file read scope.',
          docsUrl: 'https://www.figma.com/developers/api#access-tokens',
          required: true,
          secret: true,
        },
      ],
    },
    egressAllow: ['api.figma.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: true },
    tags: ['design', 'figma', 'ui'],
    homepage: 'https://github.com/GLips/Figma-Context-MCP',
  },
  {
    slug: 'stripe',
    displayName: 'Stripe',
    description: 'Inspect customers, payments, and subscriptions in Stripe.',
    category: 'finance',
    provenance: 'curated',
    launch: { transport: 'streamable-http', url: 'https://mcp.stripe.com' },
    auth: {
      kind: 'oauth',
      inputs: [],
      scopesRationale: 'Stripe scopes the grant through its own consent screen.',
      setupGuide: {
        console: 'Stripe Dashboard',
        url: 'https://dashboard.stripe.com/',
        steps: [
          'Approve the authorization request in the browser tab that opens.',
          'Start in TEST mode — a live-mode grant lets an agent move real money.',
          'Return to clawboo — the tile clears its amber key badge on success.',
        ],
      },
    },
    egressAllow: ['mcp.stripe.com', 'api.stripe.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: true },
    tags: ['payments', 'billing', 'finance'],
    homepage: 'https://docs.stripe.com/mcp',
  },
  {
    slug: 'stripe-local',
    displayName: 'Stripe (local)',
    description: 'Same Stripe tools, run as a local process with your own API key.',
    category: 'finance',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@stripe/mcp@0.3.3'],
      pinnedVersion: '0.3.3',
    },
    auth: {
      kind: 'api-key',
      inputs: [
        {
          key: 'STRIPE_SECRET_KEY',
          description: 'A Stripe secret key. Use a TEST key (sk_test_…) unless you mean it.',
          docsUrl: 'https://dashboard.stripe.com/apikeys',
          required: true,
          secret: true,
        },
      ],
    },
    egressAllow: ['api.stripe.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: true },
    tags: ['payments', 'billing', 'finance', 'self-hosted'],
    homepage: 'https://www.npmjs.com/package/@stripe/mcp',
  },
]
