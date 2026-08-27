// Curated: the SaaS canon of docs, chat, design and payments.
// Same verification rule as ./dev.ts.

import type { ConnectorDefinition } from '../types'

export const PRODUCTIVITY_CONNECTORS: ConnectorDefinition[] = [
  {
    slug: 'composio',
    displayName: 'Composio',
    description: 'Reach Gmail, Slack, Jira, Salesforce and hundreds more through Composio.',
    category: 'productivity',
    provenance: 'curated',
    // A BROKER, and the only one in this file. Every other curated entry talks
    // to one service; this one talks to a company that talks to hundreds. That
    // is the whole reason to carry it: clawboo cannot register an OAuth app
    // with Google or Atlassian or Salesforce, so the connectors it can offer
    // stop exactly where brokered sign-in begins.
    //
    // Its endpoint is a standards-compliant MCP resource server, so nothing
    // here is special-cased: it advertises its authorization server at
    // /.well-known/oauth-protected-resource, that server offers dynamic client
    // registration with PKCE and a public client, and clawboo's ordinary OAuth
    // path handles all of it. There is no API key to paste and no Composio
    // code anywhere in this repo.
    launch: { transport: 'streamable-http', url: 'https://connect.composio.dev/mcp' },
    auth: {
      kind: 'oauth',
      inputs: [],
      // SAID PLAINLY, because it is the part a reader would otherwise discover
      // afterwards. Connecting an app through a broker means the broker holds
      // that app's tokens, not clawboo, and can use them whenever it likes.
      scopesRationale:
        "Composio signs you in to each app and keeps that app's access and refresh tokens on its own servers. clawboo holds only a token for Composio itself. Anything you connect here is reachable by Composio, not just by your agents.",
      setupGuide: {
        console: 'Composio',
        url: 'https://composio.dev',
        steps: [
          'Approve the authorization request in the browser tab that opens.',
          'Connect the apps you want from inside Composio.',
          'Return to clawboo. The tile clears its amber key badge on success.',
        ],
      },
    },
    egressAllow: ['connect.composio.dev', 'login.composio.dev', 'backend.composio.dev'],
    // Every leg is true and cannot be narrowed. A broker reads whatever the
    // apps behind it read, carries back whatever they contain, and sends
    // wherever they send.
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['broker', 'gmail', 'slack', 'jira', 'salesforce', 'hubspot', 'calendar', 'oauth'],
    homepage: 'https://docs.composio.dev',
  },
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
          label: 'Notion internal integration token',
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
          'Use the page menu to connect the integration. Notion grants nothing by default.',
        ],
      },
    },
    egressAllow: ['api.notion.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: ['docs', 'wiki', 'notes', 'database'],
    homepage: 'https://github.com/makenotion/notion-mcp-server',
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
          label: 'Figma personal access token',
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
          'Start in TEST mode. A live-mode grant lets an agent move real money.',
          'Return to clawboo. The tile clears its amber key badge on success.',
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
          label: 'Stripe secret key',
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
