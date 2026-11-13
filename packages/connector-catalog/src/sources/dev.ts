// Curated: developer + coordination connectors.
//
// Every entry below was resolved against the live npm registry (stdio) or dialed
// (remote) while writing it, and pinned to the version that answered. Nothing in
// this file is aspirational: an entry whose package or endpoint could not be
// verified was left out rather than guessed at, because a directory that lists a
// connector which does not install is worse than a shorter directory.
//
// Remote entries were confirmed to return HTTP 401 to an unauthenticated
// `initialize`, which is the MCP authorization spec working as designed, and is
// the signal that OAuth discovery will have something to discover.

import type { ConnectorDefinition } from '../types'

export const DEV_CONNECTORS: ConnectorDefinition[] = [
  {
    slug: 'github',
    popular: true,
    displayName: 'GitHub',
    description: 'Read and write issues, pull requests, and repository contents.',
    category: 'dev',
    provenance: 'curated',
    launch: { transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' },
    // BEARER, NOT OAUTH, and that single word is what turns this entry from a
    // dead end into a one-field connect. GitHub's authorization server publishes
    // no dynamic registration endpoint and clawboo ships no client secret, so
    // the sign-in path could only ever fail three requests in. Its remote MCP
    // server does accept a personal access token as `Authorization: Bearer`, and
    // clawboo already carries a static bearer end to end.
    //
    // The OAuth door is deliberately left open rather than deleted: if GitHub
    // ever publishes a registration endpoint, the discovery path already handles
    // it and this becomes a one-line change back.
    auth: {
      kind: 'bearer',
      inputs: [
        {
          key: 'GITHUB_TOKEN',
          label: 'GitHub token',
          description: 'A fine-grained token, scoped to the repos you want your agents to see.',
          docsUrl: 'https://github.com/settings/personal-access-tokens/new',
          required: true,
          secret: true,
        },
      ],
      scopes: ['repo', 'read:org'],
      scopesRationale:
        'Repository access to read and file issues and pull requests; org read to resolve team mentions.',
      setupGuide: {
        console: 'GitHub',
        url: 'https://github.com/settings/personal-access-tokens/new',
        steps: [
          'Create a fine-grained personal access token.',
          'Pick the specific repositories your agents should work in, not "all repositories".',
          // READ AND WRITE, because the entry's own description promises writes.
          // Asking for read-only produced a token that connects, lists its tools,
          // and then fails on the first thing the connector says it can do.
          'Give it Read and write on Contents, Issues and Pull requests, then copy it back here.',
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
    popular: true,
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
          'Return to clawboo. The tile clears its amber key badge on success.',
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
    popular: true,
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
          'Return to clawboo. The tile clears its amber key badge on success.',
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
          label: 'Sentry auth token',
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
    popular: true,
    displayName: 'Playwright',
    description: 'Drive a real browser: navigate, click, fill forms, and read the page.',
    category: 'browser',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.79'],
      pinnedVersion: '0.0.79',
      // One browser profile per agent, so two Boos can hold different logins on
      // the same site. Verified present in 0.0.79's own --help.
      perAgentProfileFlag: '--user-data-dir',
      // Verified in 0.0.79: each origin becomes a context route that aborts
      // every request to it, navigations and subresources alike. A route never
      // sees a redirect hop or a WebSocket, so a local page that answers 302 to
      // the dashboard loaded it; the host rule below is what catches those.
      blockOriginsArg: { flag: '--blocked-origins', style: 'origins' },
      // Verified in 0.0.79: --config reads a JSON file, and the Chrome switches
      // in its browser.launchOptions.args reach the browser alongside the CLI
      // flags Clawboo passes, a persistent profile included.
      chromeSwitchArg: { flag: '--config', style: 'playwrightConfig' },
    },
    auth: { kind: 'none', inputs: [] },
    // Deliberately broad: a browser can reach anything. The egress allowlist is
    // not a meaningful control here, so the connector is honest about it rather
    // than shipping a list that implies containment it does not provide.
    egressAllow: ['*'],
    trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    // 0.0.79 marks 19 of its 24 default tools destructive, navigate, click and
    // type included, which put the whole browser behind an admin grant. These
    // four are the ones that are: arbitrary code in the page or in Playwright,
    // and the two that can hand a local file to a website. Checked against
    // 0.0.79's own tools/list; re-check when the pin moves.
    destructiveTools: [
      'browser_run_code_unsafe',
      'browser_evaluate',
      'browser_file_upload',
      'browser_drop',
    ],
    tags: ['browser', 'automation', 'testing', 'scraping'],
    homepage: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    slug: 'chrome-devtools',
    popular: true,
    displayName: 'Chrome DevTools',
    description: 'Inspect a running page: console, network, performance traces.',
    category: 'browser',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@1.7.0'],
      pinnedVersion: '1.7.0',
      // Same idea, different spelling: this one takes --userDataDir. Verified
      // present in 1.7.0's own --help.
      perAgentProfileFlag: '--userDataDir',
      // Verified in 1.7.0: URLPattern strings, checked on navigation and on
      // runtime requests (its bundled polyfill covers Node 22). Clawboo also
      // passes file: and view-source: here, which this server opened and put in
      // its snapshot otherwise.
      blockOriginsArg: { flag: '--blockedUrlPattern', style: 'urlPatterns' },
      // Verified in 1.7.0: each --chromeArg value is a Chrome launch switch.
      chromeSwitchArg: { flag: '--chromeArg', style: 'joined' },
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: ['*'],
    trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    // The opposite problem to Playwright's: 1.7.0 marks NO tool destructive, so
    // running arbitrary script in the page and handing a local file to a site
    // were plain writes that a remembered approval would let run unattended.
    // Checked against 1.7.0's own tools/list; re-check when the pin moves.
    destructiveTools: ['evaluate_script', 'upload_file'],
    tags: ['browser', 'debugging', 'performance', 'devtools'],
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
  {
    slug: 'cua-driver',
    displayName: 'Cua Driver',
    description:
      "Use the apps on an agent's own screen: windows, clicks, typing and each app's accessibility tree. Linux only.",
    category: 'desktop',
    provenance: 'curated',
    launch: {
      transport: 'stdio',
      // Installed by Clawboo into its runtimes folder (Install the desktop
      // tools), from the release below, checked against its SHA-256.
      command: 'cua-driver',
      // `--direct`: this process is the driver. Without it, `mcp` can hand its
      // calls to one long-lived `cua-driver serve`, shared by every caller of
      // the same home and outliving Clawboo, on whatever screen it started on.
      args: ['mcp', '--direct'],
      pinnedVersion: '0.38.0',
      ownedBinary: true,
      // Each agent's own driver, on that agent's own display and never another.
      perAgentDisplay: true,
      platforms: ['linux'],
    },
    auth: { kind: 'none', inputs: [] },
    // It drives whatever runs on the screen, a browser included.
    egressAllow: ['*'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    // Checked against 0.38.0's own tools/list (66 tools). These run code, start
    // or stop programs, install things, change the driver's own settings, or
    // move a file between the computer and a website.
    destructiveTools: [
      'run_script',
      'run_steps',
      'replay_trajectory',
      'launch_app',
      'kill_app',
      'install_extension',
      'install_ffmpeg',
      'check_for_update',
      'set_config',
      'browser_set_input_files',
      'browser_download',
      'clipboard_write',
      // Starts a browser of the driver's own, without Clawboo's guards.
      'browser_prepare',
    ],
    // Each writes a file wherever it is told (a screenshot, a recording),
    // through the read-only `get_window_state` and `get_desktop_state` too.
    fileWritingArgs: ['screenshot_out_file', 'output_dir'],
    tags: ['desktop', 'computer use', 'linux', 'automation', 'accessibility'],
    homepage: 'https://github.com/trycua/cua',
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
    requiresUserArgument: true,
    userArgument: {
      label: 'Folder this connector may read and write',
      description:
        'Only this folder and everything inside it. The server refuses to start without one.',
      example: '/Users/you/projects/notes',
      replacesArg: '/path/to/allowed/dir',
    },
    auth: { kind: 'none', inputs: [] },
    egressAllow: [],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: false },
    tags: ['files', 'local', 'read', 'write'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'cloudflare',
    popular: true,
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
          label: 'Cloudflare API token',
          description: 'A scoped Cloudflare API token, not your global API key.',
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
