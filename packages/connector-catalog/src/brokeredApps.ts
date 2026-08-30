// Apps reachable through a broker. Display rows, not connectors.
//
// NOT ConnectorDefinitions, and that distinction is the whole lesson of the
// previous attempt. These were once declared as full catalog connectors that
// copied the broker's launch URL, auth block and egress list. Nothing
// downstream agreed: they can never be launched, they never hold a session,
// the connect route refuses them, and eleven separate places had to be taught
// that this particular kind of connector is not really one. A row that exists
// to be looked at and pressed does not need to pretend it can be spawned.
//
// WHAT EACH ROW IS FOR. `slug` is clawboo's name for the app and the key its
// logo is found under. `toolkit` is the BROKER's name for the same app, and
// the two disagree often enough that guessing would connect the wrong thing:
// `googlecalendar` against `google-calendar`, `microsoft_teams` against
// `microsoft-teams`. Every toolkit name below was confirmed against the
// broker's own live toolkit page rather than inferred from the display name.
//
// COMMITTED RATHER THAN FETCHED, for the same reason the rest of the catalog
// is: the shelf renders with the network off. Only whether an app is CONNECTED
// comes from the broker, and that is a fact about the operator's account
// rather than about which apps exist.

import type { ConnectorCategory } from './types'

export interface BrokeredApp {
  /** clawboo's slug. Also the key its brand mark is stored under. */
  slug: string
  name: string
  /** The broker's own name for this app. Not derivable from `slug`. */
  toolkit: string
  category: ConnectorCategory
  description: string
  /** Belongs in the shelf's first band. */
  popular?: boolean
}

export const BROKERED_APPS: readonly BrokeredApp[] = Object.freeze([
  {
    slug: 'gmail',
    name: 'Gmail',
    toolkit: 'gmail',
    category: 'productivity',
    description: 'Read, search, draft and send mail in a Gmail account.',
    popular: true,
  },
  {
    slug: 'slack',
    name: 'Slack',
    toolkit: 'slack',
    category: 'chat',
    description: 'Read channel history, search a workspace, and post messages.',
    popular: true,
  },
  {
    slug: 'google-calendar',
    name: 'Google Calendar',
    toolkit: 'googlecalendar',
    category: 'productivity',
    description: 'Read a calendar, create and move events, and find free time.',
    popular: true,
  },
  {
    slug: 'google-drive',
    name: 'Google Drive',
    toolkit: 'googledrive',
    category: 'docs',
    description: 'Search Drive, read file contents, and upload new files.',
    popular: true,
  },
  {
    slug: 'google-docs',
    name: 'Google Docs',
    toolkit: 'googledocs',
    category: 'docs',
    description: 'Create a document, read it, and edit its contents.',
    popular: true,
  },
  {
    slug: 'google-sheets',
    name: 'Google Sheets',
    toolkit: 'googlesheets',
    category: 'data',
    description: 'Read and write cells, add sheets, and append rows.',
    popular: true,
  },
  {
    slug: 'outlook',
    name: 'Outlook',
    toolkit: 'outlook',
    category: 'productivity',
    description: 'Read, draft and send mail, and manage the calendar, in Outlook.',
    popular: true,
  },
  {
    slug: 'microsoft-teams',
    name: 'Microsoft Teams',
    toolkit: 'microsoft_teams',
    category: 'chat',
    description: 'Read channel and chat messages, and post into them.',
    popular: true,
  },
  {
    slug: 'zoom',
    name: 'Zoom',
    toolkit: 'zoom',
    category: 'chat',
    description: 'Create meetings, and read recordings and registrants.',
    popular: true,
  },
  {
    slug: 'dropbox',
    name: 'Dropbox',
    toolkit: 'dropbox',
    category: 'docs',
    description: 'List folders, read files, and upload to Dropbox.',
    popular: true,
  },
  {
    slug: 'jira',
    name: 'Jira',
    toolkit: 'jira',
    category: 'issues',
    description: 'Read, file, comment on, and transition Jira issues.',
    popular: true,
  },
  {
    slug: 'asana',
    name: 'Asana',
    toolkit: 'asana',
    category: 'issues',
    description: 'Read and update Asana tasks, projects, and assignees.',
    popular: true,
  },
  {
    slug: 'trello',
    name: 'Trello',
    toolkit: 'trello',
    category: 'issues',
    description: 'Read Trello boards and move cards between lists.',
    popular: true,
  },
  {
    slug: 'salesforce',
    name: 'Salesforce',
    toolkit: 'salesforce',
    category: 'productivity',
    description: 'Read and update leads, contacts, accounts, and opportunities.',
    popular: true,
  },
  {
    slug: 'linkedin',
    name: 'LinkedIn',
    toolkit: 'linkedin',
    category: 'productivity',
    description: 'Publish posts and comments, and read your own profile.',
    popular: true,
  },
  {
    slug: 'confluence',
    name: 'Confluence',
    toolkit: 'confluence',
    category: 'docs',
    description: 'Read and edit Confluence pages and spaces.',
  },
  {
    slug: 'onedrive',
    name: 'OneDrive',
    toolkit: 'one_drive',
    category: 'docs',
    description: 'List, read, copy and upload files in OneDrive.',
  },
  {
    slug: 'canva',
    name: 'Canva',
    toolkit: 'canva',
    category: 'docs',
    description: 'Create Canva designs, read their metadata, and export them.',
  },
  {
    slug: 'telegram',
    name: 'Telegram',
    toolkit: 'telegram',
    category: 'chat',
    description: 'Send and read Telegram messages through a bot.',
  },
  {
    slug: 'whatsapp-business',
    name: 'WhatsApp Business',
    toolkit: 'whatsapp',
    category: 'chat',
    description: 'Send messages and templates from a WhatsApp Business number.',
  },
  {
    slug: 'google-bigquery',
    name: 'Google BigQuery',
    toolkit: 'googlebigquery',
    category: 'data',
    description: 'Run SQL against BigQuery and read table schemas.',
  },
  {
    slug: 'snowflake',
    name: 'Snowflake',
    toolkit: 'snowflake',
    category: 'data',
    description: 'Run SQL against Snowflake and check statement status.',
  },
  {
    slug: 'google-analytics',
    name: 'Google Analytics',
    toolkit: 'google_analytics',
    category: 'data',
    description: 'Run reports on a GA4 property and read its audiences.',
  },
  {
    slug: 'clickup',
    name: 'ClickUp',
    toolkit: 'clickup',
    category: 'issues',
    description: 'Read and update ClickUp tasks, lists, and docs.',
  },
  {
    slug: 'monday-com',
    name: 'Monday.com',
    toolkit: 'monday',
    category: 'issues',
    description: 'Read and update boards, items, and columns.',
  },
  {
    slug: 'todoist',
    name: 'Todoist',
    toolkit: 'todoist',
    category: 'productivity',
    description: 'Read, add, and close Todoist tasks and projects.',
  },
  {
    slug: 'gitlab',
    name: 'GitLab',
    toolkit: 'gitlab',
    category: 'dev',
    description: 'Read and write GitLab projects, issues, and branches.',
  },
  {
    slug: 'bitbucket',
    name: 'Bitbucket',
    toolkit: 'bitbucket',
    category: 'dev',
    description: 'Read repositories, and open, comment on, and approve pull requests.',
  },
  {
    slug: 'vercel',
    name: 'Vercel',
    toolkit: 'vercel',
    category: 'dev',
    description: 'Inspect Vercel deployments, logs, and environment variables.',
  },
  {
    slug: 'sendgrid',
    name: 'SendGrid',
    toolkit: 'sendgrid',
    category: 'dev',
    description: 'Send mail through SendGrid and manage contacts and templates.',
  },
  {
    slug: 'pagerduty',
    name: 'PagerDuty',
    toolkit: 'pagerduty',
    category: 'observability',
    description: 'Read incidents and escalation policies, and see who is on call.',
  },
  {
    slug: 'datadog',
    name: 'Datadog',
    toolkit: 'datadog',
    category: 'observability',
    description: 'Read monitors, events, incidents, and dashboards in Datadog.',
  },
  {
    slug: 'posthog',
    name: 'PostHog',
    toolkit: 'posthog',
    category: 'observability',
    description: 'Read events, cohorts, dashboards, and feature flags in PostHog.',
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    toolkit: 'hubspot',
    category: 'productivity',
    description: 'Read and update HubSpot contacts, companies, and deals.',
  },
  {
    slug: 'zendesk',
    name: 'Zendesk',
    toolkit: 'zendesk',
    category: 'productivity',
    description: 'Read, reply to, and update Zendesk tickets.',
  },
  {
    slug: 'intercom',
    name: 'Intercom',
    toolkit: 'intercom',
    category: 'productivity',
    description: 'Read Intercom conversations and contacts, and reply to them.',
  },
  {
    slug: 'quickbooks',
    name: 'QuickBooks',
    toolkit: 'quickbooks',
    category: 'finance',
    description: 'Read and create invoices, bills, customers, and payments.',
  },
  {
    slug: 'xero',
    name: 'Xero',
    toolkit: 'xero',
    category: 'finance',
    description: 'Read and create invoices, contacts, and payments in Xero.',
  },
  {
    slug: 'shopify',
    name: 'Shopify',
    toolkit: 'shopify',
    category: 'finance',
    description: 'Read orders, products, customers, and inventory in a store.',
  },
  {
    slug: 'mailchimp',
    name: 'Mailchimp',
    toolkit: 'mailchimp',
    category: 'productivity',
    description: 'Read audiences and campaigns, and add or update subscribers.',
  },
  {
    slug: 'x-twitter',
    name: 'X (Twitter)',
    toolkit: 'twitter',
    category: 'productivity',
    description: 'Read a timeline, search posts, and publish new ones.',
  },
])

/** clawboo slug for a broker toolkit name, or null. */
export function appForToolkit(toolkit: string): BrokeredApp | null {
  const want = toolkit.toLowerCase()
  return BROKERED_APPS.find((a) => a.toolkit.toLowerCase() === want) ?? null
}

/** Every toolkit name, for the one call that asks which are connected. */
export const BROKERED_TOOLKITS: readonly string[] = Object.freeze(
  BROKERED_APPS.map((a) => a.toolkit),
)
