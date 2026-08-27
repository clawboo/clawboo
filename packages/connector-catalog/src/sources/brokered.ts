// Apps clawboo reaches through a broker rather than on its own.
//
// WHY THESE EXIST. clawboo cannot register an OAuth application with Google or
// Atlassian or Salesforce, so the connectors it can offer directly stop exactly
// where brokered sign-in begins. That is why there was no Gmail, no Slack, no
// Jira: not an oversight, a boundary. Composio is on the other side of it, and
// every entry here is one app reached through that one connection.
//
// ORDINARY ROWS, DELIBERATELY. These sit in the shelf beside clawboo's own
// connectors rather than in a section named after the broker, because the
// person looking for Gmail is looking for Gmail. Which company brokers the
// sign-in is a fact about plumbing, and it is disclosed where it becomes
// relevant: on the connector's own detail view, and on the broker's consent
// screen, which names itself.
//
// NOTHING HERE DUPLICATES A CONNECTOR CLAWBOO ALREADY HAS. GitHub, Linear,
// Notion, Sentry, Stripe, Figma, Airtable, Supabase, Cloudflare and SQLite are
// all brokered by Composio too, and all of them are absent from this file:
// clawboo's own connector wins, every time, and `verify-connectors` fails the
// build if a slug here collides with a curated or community one.
//
// SLUGS ARE TWO NAMESPACES. `slug` is what clawboo calls the app. `toolkit` is
// what the broker calls it, and the two disagree often enough that guessing
// would connect the wrong thing: `googlecalendar` against `google-calendar`,
// `microsoft_teams` against `microsoft-teams`, `one_drive` against `onedrive`.
// Every toolkit name below was confirmed against the broker's own live toolkit
// page rather than inferred from the display name.

import type { ConnectorCategory, ConnectorDefinition } from '../types'
import { COMPOSIO_CONNECTOR } from './productivity'

interface BrokeredSpec {
  slug: string
  displayName: string
  description: string
  category: ConnectorCategory
  /** The broker's own name for this app. Not derivable from `slug`. */
  toolkit: string
  popular?: boolean
}

const SPECS: readonly BrokeredSpec[] = [
  {
    slug: 'gmail',
    displayName: 'Gmail',
    description: 'Read, search, draft and send mail in a Gmail account.',
    category: 'productivity',
    toolkit: 'gmail',
    popular: true,
  },
  {
    slug: 'slack',
    displayName: 'Slack',
    description: 'Read channel history, search a workspace, and post messages.',
    category: 'chat',
    toolkit: 'slack',
    popular: true,
  },
  {
    slug: 'google-calendar',
    displayName: 'Google Calendar',
    description: 'Read a calendar, create and move events, and find free time.',
    category: 'productivity',
    toolkit: 'googlecalendar',
    popular: true,
  },
  {
    slug: 'google-drive',
    displayName: 'Google Drive',
    description: 'Search Drive, read file contents, and upload new files.',
    category: 'docs',
    toolkit: 'googledrive',
    popular: true,
  },
  {
    slug: 'google-docs',
    displayName: 'Google Docs',
    description: 'Create a document, read it, and edit its contents.',
    category: 'docs',
    toolkit: 'googledocs',
    popular: true,
  },
  {
    slug: 'google-sheets',
    displayName: 'Google Sheets',
    description: 'Read and write cells, add sheets, and append rows.',
    category: 'data',
    toolkit: 'googlesheets',
    popular: true,
  },
  {
    slug: 'outlook',
    displayName: 'Outlook',
    description: 'Read, draft and send mail, and manage the calendar, in Outlook.',
    category: 'productivity',
    toolkit: 'outlook',
    popular: true,
  },
  {
    slug: 'microsoft-teams',
    displayName: 'Microsoft Teams',
    description: 'Read channel and chat messages, and post into them.',
    category: 'chat',
    toolkit: 'microsoft_teams',
    popular: true,
  },
  {
    slug: 'zoom',
    displayName: 'Zoom',
    description: 'Create meetings, and read recordings and registrants.',
    category: 'chat',
    toolkit: 'zoom',
    popular: true,
  },
  {
    slug: 'dropbox',
    displayName: 'Dropbox',
    description: 'List folders, read files, and upload to Dropbox.',
    category: 'docs',
    toolkit: 'dropbox',
    popular: true,
  },
  {
    slug: 'jira',
    displayName: 'Jira',
    description: 'Read, file, comment on, and transition Jira issues.',
    category: 'issues',
    toolkit: 'jira',
    popular: true,
  },
  {
    slug: 'asana',
    displayName: 'Asana',
    description: 'Read and update Asana tasks, projects, and assignees.',
    category: 'issues',
    toolkit: 'asana',
    popular: true,
  },
  {
    slug: 'trello',
    displayName: 'Trello',
    description: 'Read Trello boards and move cards between lists.',
    category: 'issues',
    toolkit: 'trello',
    popular: true,
  },
  {
    slug: 'salesforce',
    displayName: 'Salesforce',
    description: 'Read and update leads, contacts, accounts, and opportunities.',
    category: 'productivity',
    toolkit: 'salesforce',
    popular: true,
  },
  {
    slug: 'linkedin',
    displayName: 'LinkedIn',
    description: 'Publish posts and comments, and read your own profile.',
    category: 'productivity',
    toolkit: 'linkedin',
    popular: true,
  },
  {
    slug: 'confluence',
    displayName: 'Confluence',
    description: 'Read and edit Confluence pages and spaces.',
    category: 'docs',
    toolkit: 'confluence',
  },
  {
    slug: 'onedrive',
    displayName: 'OneDrive',
    description: 'List, read, copy and upload files in OneDrive.',
    category: 'docs',
    toolkit: 'one_drive',
  },
  {
    slug: 'canva',
    displayName: 'Canva',
    description: 'Create Canva designs, read their metadata, and export them.',
    category: 'docs',
    toolkit: 'canva',
  },
  {
    slug: 'telegram',
    displayName: 'Telegram',
    description: 'Send and read Telegram messages through a bot.',
    category: 'chat',
    toolkit: 'telegram',
  },
  {
    slug: 'whatsapp-business',
    displayName: 'WhatsApp Business',
    description: 'Send messages and templates from a WhatsApp Business number.',
    category: 'chat',
    toolkit: 'whatsapp',
  },
  {
    slug: 'google-bigquery',
    displayName: 'Google BigQuery',
    description: 'Run SQL against BigQuery and read table schemas.',
    category: 'data',
    toolkit: 'googlebigquery',
  },
  {
    slug: 'snowflake',
    displayName: 'Snowflake',
    description: 'Run SQL against Snowflake and check statement status.',
    category: 'data',
    toolkit: 'snowflake',
  },
  {
    slug: 'google-analytics',
    displayName: 'Google Analytics',
    description: 'Run reports on a GA4 property and read its audiences.',
    category: 'data',
    toolkit: 'google_analytics',
  },
  {
    slug: 'clickup',
    displayName: 'ClickUp',
    description: 'Read and update ClickUp tasks, lists, and docs.',
    category: 'issues',
    toolkit: 'clickup',
  },
  {
    slug: 'monday-com',
    displayName: 'Monday.com',
    description: 'Read and update boards, items, and columns.',
    category: 'issues',
    toolkit: 'monday',
  },
  {
    slug: 'todoist',
    displayName: 'Todoist',
    description: 'Read, add, and close Todoist tasks and projects.',
    category: 'productivity',
    toolkit: 'todoist',
  },
  {
    slug: 'gitlab',
    displayName: 'GitLab',
    description: 'Read and write GitLab projects, issues, and branches.',
    category: 'dev',
    toolkit: 'gitlab',
  },
  {
    slug: 'bitbucket',
    displayName: 'Bitbucket',
    description: 'Read repositories, and open, comment on, and approve pull requests.',
    category: 'dev',
    toolkit: 'bitbucket',
  },
  {
    slug: 'vercel',
    displayName: 'Vercel',
    description: 'Inspect Vercel deployments, logs, and environment variables.',
    category: 'dev',
    toolkit: 'vercel',
  },
  {
    slug: 'sendgrid',
    displayName: 'SendGrid',
    description: 'Send mail through SendGrid and manage contacts and templates.',
    category: 'dev',
    toolkit: 'sendgrid',
  },
  {
    slug: 'pagerduty',
    displayName: 'PagerDuty',
    description: 'Read incidents and escalation policies, and see who is on call.',
    category: 'observability',
    toolkit: 'pagerduty',
  },
  {
    slug: 'datadog',
    displayName: 'Datadog',
    description: 'Read monitors, events, incidents, and dashboards in Datadog.',
    category: 'observability',
    toolkit: 'datadog',
  },
  {
    slug: 'posthog',
    displayName: 'PostHog',
    description: 'Read events, cohorts, dashboards, and feature flags in PostHog.',
    category: 'observability',
    toolkit: 'posthog',
  },
  {
    slug: 'hubspot',
    displayName: 'HubSpot',
    description: 'Read and update HubSpot contacts, companies, and deals.',
    category: 'productivity',
    toolkit: 'hubspot',
  },
  {
    slug: 'zendesk',
    displayName: 'Zendesk',
    description: 'Read, reply to, and update Zendesk tickets.',
    category: 'productivity',
    toolkit: 'zendesk',
  },
  {
    slug: 'intercom',
    displayName: 'Intercom',
    description: 'Read Intercom conversations and contacts, and reply to them.',
    category: 'productivity',
    toolkit: 'intercom',
  },
  {
    slug: 'quickbooks',
    displayName: 'QuickBooks',
    description: 'Read and create invoices, bills, customers, and payments.',
    category: 'finance',
    toolkit: 'quickbooks',
  },
  {
    slug: 'xero',
    displayName: 'Xero',
    description: 'Read and create invoices, contacts, and payments in Xero.',
    category: 'finance',
    toolkit: 'xero',
  },
  {
    slug: 'shopify',
    displayName: 'Shopify',
    description: 'Read orders, products, customers, and inventory in a store.',
    category: 'finance',
    toolkit: 'shopify',
  },
  {
    slug: 'mailchimp',
    displayName: 'Mailchimp',
    description: 'Read audiences and campaigns, and add or update subscribers.',
    category: 'productivity',
    toolkit: 'mailchimp',
  },
  {
    slug: 'x-twitter',
    displayName: 'X (Twitter)',
    description: 'Read a timeline, search posts, and publish new ones.',
    category: 'productivity',
    toolkit: 'twitter',
  },
]

/**
 * One brokered app, wearing the broker's reachability.
 *
 * `launch` and `egressAllow` are READ FROM THE BROKER rather than restated, so
 * there is exactly one place that knows where Composio lives. The trifecta is
 * every leg true and cannot be narrowed: an app reached through a broker reads
 * whatever it reads, carries back whatever it contains, and sends wherever it
 * sends.
 */
function brokered(spec: BrokeredSpec): ConnectorDefinition {
  return {
    slug: spec.slug,
    displayName: spec.displayName,
    description: spec.description,
    category: spec.category,
    provenance: 'curated',
    ...(spec.popular ? { popular: true } : {}),
    brokeredBy: { connector: COMPOSIO_CONNECTOR.slug, toolkit: spec.toolkit },
    launch: COMPOSIO_CONNECTOR.launch,
    auth: {
      kind: 'oauth',
      inputs: [],
      scopesRationale: `Signing in happens at ${spec.displayName}, through Composio. Composio keeps the resulting access and refresh tokens on its own servers; clawboo holds only a token for Composio.`,
    },
    egressAllow: COMPOSIO_CONNECTOR.egressAllow,
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    tags: [spec.category, 'brokered'],
    homepage: COMPOSIO_CONNECTOR.homepage,
  }
}

export const BROKERED_CONNECTORS: ConnectorDefinition[] = SPECS.map(brokered)
