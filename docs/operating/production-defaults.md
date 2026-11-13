---
title: 'Production defaults'
description: 'What a fresh Clawboo install allows and limits out of the box, and how to change each default before you run it for a team.'
keywords:
  [
    'defaults',
    'posture',
    'rate limit',
    'budgets',
    'OpenTelemetry',
    'HOST',
    'STUDIO_ACCESS_TOKEN',
    'Production defaults & posture',
  ]
---

Use this page before you run Clawboo for anyone but yourself. It lists the defaults that decide who can reach the server, how much it accepts, what limits spending, and what leaves the machine, with how to change each one. Every other number, such as breaker thresholds and timeouts, is in [Limits and defaults](/reference/limits-and-defaults).

## At a glance

| Default                                         | Out of the box                                                                                                                                                                                                                    | How to change it                                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Network bind                                    | `127.0.0.1`: only this machine can connect                                                                                                                                                                                        | Set `HOST`, for example `HOST=0.0.0.0`. See [Reach Clawboo from another machine](/guides/self-host-securely).                                                                  |
| Port                                            | The first free port from 18790 to 18809                                                                                                                                                                                           | `CLAWBOO_API_PORT` pins one port (startup fails if it is taken). `CLAWBOO_API_PORT_START` moves the scan.                                                                      |
| Access token                                    | On: a per-install token in `~/.clawboo/access-token`, readable only by you, made on the first start                                                                                                                               | Set `STUDIO_ACCESS_TOKEN` to choose it, using only letters, digits, `.`, `_`, `~` and `-`; any other character stops the server at startup. Set it blank to turn the gate off. |
| Wide bind with the token off                    | The server refuses to start                                                                                                                                                                                                       | Keep the token on. `CLAWBOO_ALLOW_INSECURE=1` starts it with no protection.                                                                                                    |
| Same-origin guard                               | On: API calls must arrive under a local name (`localhost`, a `127.x` address, `::1`, or the bind address)                                                                                                                         | `CLAWBOO_ALLOWED_HOSTS` and `CLAWBOO_ALLOWED_ORIGINS` add names. Nothing turns the guard off.                                                                                  |
| Path prefix                                     | The dashboard is served at `/`                                                                                                                                                                                                    | `CLAWBOO_BASE_PATH`, for example `/clawboo`.                                                                                                                                   |
| API rate limit                                  | 3,000 requests a minute per client address, across `/api`                                                                                                                                                                         | Fixed.                                                                                                                                                                         |
| Sensitive-route limit                           | 60 requests a minute per client address, on 31 routes                                                                                                                                                                             | Fixed.                                                                                                                                                                         |
| Request body                                    | JSON up to 2 MB                                                                                                                                                                                                                   | Fixed.                                                                                                                                                                         |
| Budgets                                         | None exist. A new budget is **warn only**                                                                                                                                                                                         | Create one in **Settings > Insights > Governance** and choose **hard cap**.                                                                                                    |
| Install-wide spend cap                          | None                                                                                                                                                                                                                              | No setting. Cap each agent or team instead.                                                                                                                                    |
| Coding runtimes' sandboxes and approval prompts | Off for Claude Code, Codex and Hermes                                                                                                                                                                                             | No setting. For untrusted work, run Clawboo under a separate user account or in a VM. See [What agents can do](/concepts/permissions).                                         |
| Clawboo Native shell commands                   | Off for every agent                                                                                                                                                                                                               | Turn on **Let this Boo ask to run commands** on the agent's **Permissions** tab.                                                                                               |
| OpenTelemetry export                            | Off: traces stay in the local event log                                                                                                                                                                                           | `OTEL_EXPORTER_OTLP_ENDPOINT`. The npm package does not include the OpenTelemetry SDK; see below.                                                                              |
| Log level                                       | `info`                                                                                                                                                                                                                            | `LOG_LEVEL`, for example `debug`.                                                                                                                                              |
| Data folder                                     | `~/.clawboo`                                                                                                                                                                                                                      | `CLAWBOO_HOME`. See [Data and state](/operating/data-and-state).                                                                                                               |
| Work folder                                     | `~/clawboo-work`, or `<CLAWBOO_HOME>-work` when `CLAWBOO_HOME` is set: team folders, task worktrees and review checkouts                                                                                                          | `CLAWBOO_WORK_DIR`, outside the data folder. See [The work folder](/operating/data-and-state#the-work-folder).                                                                 |
| Runtimes folder                                 | `~/clawboo-runtimes`, or `<CLAWBOO_HOME>-runtimes` when `CLAWBOO_HOME` is set: the OpenClaw, Agent SDK and Codex installs Clawboo makes, never in npm's global folder                                                             | `CLAWBOO_RUNTIMES_DIR`, apart from the data and work folders. See [The runtimes folder](/operating/data-and-state#the-runtimes-folder).                                        |
| Vault master key                                | `secrets/master.key`, next to the encrypted vault                                                                                                                                                                                 | `CLAWBOO_SECRETS_MASTER_KEY`, set to the existing key. A new key makes every saved key unreadable; see [Security](/operating/security).                                        |
| Telemetry                                       | None                                                                                                                                                                                                                              | Nothing to turn off.                                                                                                                                                           |
| Requests Clawboo makes itself                   | The Marketplace catalog from GitHub and the latest version from npm (each cached 6 hours), and OpenRouter's public model list (cached 30 minutes). The dashboard also loads its font from Google Fonts and the GitHub star count. | `CLAWBOO_CATALOG_INDEX_URL` points the catalog elsewhere, and `CLAWBOO_DISABLE_SELF_UPDATE=1` stops the npm check. The others have no setting.                                 |

The server reads environment variables when it starts, so restart it after you change one. **Settings > System Health** shows three of these defaults in its **Production defaults** card: the log level, the budget posture and observability.

## Request limits

Clawboo counts requests per client address over a one-minute window, in memory. Over a limit it answers `429` with `Too many requests. Wait a moment and retry.`, or on a sensitive route `Too many requests for this operation. Wait a moment and retry.`, and sends standard `RateLimit-*` headers.

The sensitive routes are the ones that install, connect, disconnect or sign out of a runtime; start a CLI sign-in; install, set up or edit OpenClaw, control its Gateway or approve a device; update Clawboo; connect, authorize, configure or disconnect a connector, add or remove a custom connector, or set the Composio key; change a native agent's shell switch; revoke a command-allowlist entry; and reindex or install memory embeddings. The 60-a-minute limit applies on top of the general one.

The address is the connection's own, and forwarding headers are ignored. Behind a reverse proxy on the same machine, every request comes from `127.0.0.1`, so all your users share one count. The dashboard's page files have a separate limit of 3,000 a minute and do not count against the API.

## Budgets

A fresh install has no budgets, so nothing caps spend. To set a ceiling, open **Settings > Insights > Governance**, create a budget for an agent or a team, and choose **hard cap**. When spend reaches the cap, the budget pauses and that scope gets no new work; how fast a running agent stops depends on its runtime. A **warn only** budget tracks spend against its limit and never stops work. See [Budgets and spend](/using/budgets-and-spend) for what each runtime reports and how a cap stops each kind of run.

There is no install-wide cap. The API also accepts a `tenant` scope, but nothing charges or enforces it, and the Governance form does not offer it. Through the API, a new budget saved without a `mode` is warn only, and an existing one keeps its mode. System Health's **budget posture** row always shows the shipped default, `track-and-warn`, not the budgets you create.

## OpenTelemetry

Clawboo keeps traces in its local event log. To also send them to an OTLP collector, set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`); `OTEL_SERVICE_NAME` defaults to `clawboo`. Traces cover runs that go through the task runner, which are agent routines and `POST /api/runtimes/:id/run`. Team chat turns produce none.

The `clawboo` npm package does not include the OpenTelemetry SDK, so on an npm install the export does not start. System Health's **OTel exporter** check then reports that the exporter failed to initialize, and traces stay local, even though the **observability** row reads that the exporter is active. Export works when you run Clawboo from a source checkout, where the SDK is installed.

## What leaves the machine

Prompts go only to the providers and apps you connect. No Clawboo account, and Clawboo itself sends no telemetry. Besides your providers, the server makes three requests of its own. It fetches the Marketplace catalog from GitHub. It asks `registry.npmjs.org` for the latest Clawboo version when the dashboard checks for updates. And when the dashboard shows a model picker, it fetches OpenRouter's public model list, which sends no key. In your browser, the dashboard also loads its font from Google Fonts and its GitHub star count from `api.github.com`.

## Related

- [Limits and defaults](/reference/limits-and-defaults): breaker thresholds, timeouts, caps and every other number.
- [Reach Clawboo from another machine](/guides/self-host-securely): change the bind, set the token and the allowlists, and add a proxy.
- [Security](/operating/security): what the access token, the guard and the vault protect against.
- [Budgets and spend](/using/budgets-and-spend): set budgets and read what agents spend.
- [Environment variables](/reference/environment-variables): every variable on this page and the rest.
