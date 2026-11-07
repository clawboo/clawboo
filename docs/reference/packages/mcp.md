---
title: '@clawboo/mcp'
sidebarTitle: 'mcp'
description: 'Clawboo MCP servers and their transports, the client for third-party connectors with its OAuth flow, attach-URL signing, and the stdio bins.'
keywords:
  [
    '@clawboo/mcp',
    'mcp',
    'MCP servers',
    'Tasks MCP',
    'Memory MCP',
    'Tools MCP',
    'TeamChat MCP',
    'memory_feedback',
    'team_delegate',
    'attachToken',
    'scopeSig',
    'unverifiedCaller',
    'connector client',
    'OAuth',
    'clawboo-mcp-tasks',
    'CLAWBOO_DB_PATH',
  ]
---

`@clawboo/mcp` has two halves. The server half gives agents Clawboo's board, memory, tools and peer channel as four
MCP servers. The client half is how Clawboo itself connects to the third-party MCP servers you add as connectors.
Between them sits attach signing, which stops an agent from claiming an identity Clawboo did not give it.

Use this page when you add or change an MCP tool, change how runtimes attach, or work on connectors. Each tool's
inputs are listed on [MCP tools](/reference/mcp-tools), and attaching an outside agent is covered in
[MCP servers](/operating/mcp-servers). This is the only package that depends on `@modelcontextprotocol/sdk`, which
is why the connector client lives here too.

## The four servers

| Server                        | Built by                              | Tools                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks (`clawboo-tasks`)       | `createTasksServer(db, opts)`         | `list_tasks`, `get_task`, `create_task`, `create_subtask`, `claim_task`, `assign_task`, `release_task`, `update_task_status`, `block_task`, `ask_person`, `report_result`, `hand_back_task`, `write_plan`, `unblock_task`, `add_comment`, `link_task` |
| Memory (`clawboo-memory`)     | `createMemoryServer(db, embed, opts)` | `memory_save`, `memory_search`, `memory_browse`, `memory_feedback`                                                                                                                                                                                    |
| Tools (`clawboo-tools`)       | `createToolsServer(db, opts)`         | the built-ins (`echo`, `note`), plus the tools of each connected connector and the app toolkits an agent has been granted                                                                                                                             |
| TeamChat (`clawboo-teamchat`) | `createTeamChatServer(db, opts)`      | `team_chat_post`, `team_chat_subscribe`, and `team_delegate` when the binding grants delegation                                                                                                                                                       |

Each server is a thin layer over `@clawboo/db`: the handlers call its repository functions. A few behaviors matter
to anyone changing them:

- **Tasks.** `readOnly` serves only `list_tasks` and `get_task`, plus `ask_person` and `report_result` on a team run
  bound to a task and `write_plan` on a run bound to a task; Clawboo Native uses it for an agent whose Tasks access is
  set to read. `ask_person`, `report_result` and `hand_back_task` act only on the bound task of a team run, and are not
  served without one. `report_result` writes no status: it stores a claim on the run's execution, for `decideDone`.
  `block_task`, and `update_task_status` and
  `create_task` into `blocked` or `in_review`, need a `waitingOn` reason. `teamRun` is set for a run the team engine drives (signed `teamRun=1` on its Tasks, Memory and Tools URLs; Clawboo Native sets it in-process):
  it leaves out `claim_task`, `assign_task`, `release_task`, `update_task_status` and `unblock_task`, and lets
  `block_task` block only the bound agent's own task. A bound agent's `claim_task` claims for that agent. A bound
  team scope forces `list_tasks` to that team and makes `get_task` refuse another team's task. A bound task
  (`boundScope.taskId`, from the signed `scopeTaskId` of a run on a board task; `boundTaskId` on `AttachScope`) is what
  `get_task`, `add_comment` and `block_task` use when a call leaves out `taskId`. Cancelling a task
  with `update_task_status` cancels the plan steps waiting on it and leaves its delegator a mailbox note. A lost
  claim, a dependency cycle in `link_task` and a refused subtask (too many children, too deep) come back as tool
  errors the model should not retry. Every argument naming a task takes its readable id too, resolved in one wrapper
  (`acceptReadableIds`) and only within a bound team. `create_task` and `create_subtask` send an idempotency key, the
  caller's (kept to the bound task, else the agent, else the team, and to the parent and title) or one derived from
  the bound task, the parent and the title. With no bound task it derives from the team and matches only an open
  task. They mark the create as an agent's, so the same-title check applies; a repeat returns the existing task with
  `deduplicated: true`. `priority`
  stops at High (`clampAgentTaskPriority`). `assign_task` refuses a hand-off back up the chain unless the target is a
  lead, which the host names with `isLeadAgent`; the default is the team's own lead.
- **Tools.** Every call runs through the `@clawboo/db` broker, so a connector tool is checked against the agent's
  grants. A connector tool is listed only to an agent whose grant would allow it.
- **TeamChat.** `team_delegate` only signals: the team engine sees the tool call and creates the board task.
- **Comments wake no one.** `add_comment` on a session bound to an agent labels the comment `agent`, and no other caller labels it at all. Only the board route's `person` comment starts a run (`commentMayWake` in `@clawboo/board-core`). A move to Done saves its dependents' wakes in the write itself, so a stdio bin's does too; they wait for the server's next pump pass.
- **Mailbox delivery.** For a bound agent, its undelivered mailbox rows ride along on the next Tasks or TeamChat
  tool response as a second content block, each framed as data with `formatInterSessionMessage` (from
  `@clawboo/board-core`, which `formatPeerPost` is now built on).

## Transports

- **HTTP.** `createStreamableHttpHandlers` serves each server inside the dashboard server at `/api/mcp/<server>`.
  Clawboo's own Claude Code, Codex and Hermes runs and the OpenClaw Gateway connect here.
- **In-process.** `connectInMemoryClient` connects Clawboo Native's MCP bridge to the servers without a network
  hop. `probeServer` checks that a server answers, for the boot probe and the MCP supervisor.
- **stdio.** `runStdioServer` backs the four bins `clawboo-mcp-tasks`, `clawboo-mcp-memory`, `clawboo-mcp-tools`
  and `clawboo-mcp-teamchat`, for runtimes you attach yourself.

The bins are built from `packages/mcp/src/bin/*.ts` by `apps/web/tsup.mcp-bins.config.ts`, with every `@clawboo/*`
package inlined, and `scripts/assemble-cli.sh` copies them into the published `clawboo` package. Each bin opens
`createDb(defaultDbPath())`: the file named by `CLAWBOO_DB_PATH`, else `~/.openclaw/clawboo/clawboo.db`. That is a
different file from the server's `~/.clawboo/clawboo.db`, on purpose, so set `CLAWBOO_DB_PATH` to the server's
file or use the snippet from `GET /api/mcp/config`, which embeds it. The Memory bin re-resolves its embedding
provider once a minute and falls back to keyword search when there is none.

## Attach URLs and signing

`mcpHttpUrl(baseUrl, server, scope)` writes the URL a runtime attaches with, and `buildAttachConfig` wraps it in a
runtime's own config shape (a `claude mcp add` line, a Codex `config.toml` entry, an `openclaw.json` entry). A URL
Clawboo mints with the install's attach secret carries up to three signatures. An unscoped URL, such as the one
registered with a local OpenClaw Gateway, carries the token alone.

- **`attachToken`**, on every such URL: proof that the request comes from a runtime this server started. The
  access gate admits a request without the dashboard cookie only when it carries a valid token, targets one of the
  four server mounts, arrives on the loopback port directly and was not forwarded by a proxy.
  `GET /api/mcp/config` mints signed URLs, so it always needs the cookie when the gate is on.
- **`scopeSig`**, when the URL claims a team, agent or tenant: an HMAC over those and the delegation privilege.
- **`provSig`**, on Memory URLs that carry provenance stamps (runtime, task, session): it signs the stamps recorded
  with saves and feedback.

`signAttachAccess`, `signAttachScope` and `signAttachProvenance` mint these from the per-install secret, and their
`verify` partners check them in constant time. The secret never leaves the server.

## Unverified callers

A scope whose signature is missing or wrong counts as no scope at all. Over HTTP that makes the caller unverified,
and each server narrows what it serves:

| Server   | What an unverified HTTP caller gets                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Tasks    | no claims and no status writes, and `add_comment` drops its author fields; creates, comments and links still work |
| Memory   | global memory only for reads and saves, and no provenance recorded                                                |
| TeamChat | no tools at all                                                                                                   |
| Tools    | no agent or team identity, so no grant matches and connector tools stay hidden                                    |

A stdio caller with no scope is the operator running a bin and is served without these limits. OpenClaw agents are
always unverified: the Gateway registers Memory, Tasks and Tools once for all its agents, with no per-run
identity, and gets no TeamChat server. The server-side flags are `unverifiedCaller` on the Tasks, Memory and
TeamChat options.

## The connector client

When you connect a connector, Clawboo is the MCP client. The server's connector supervisor and OAuth flow
(`apps/web/server/lib/connectors/`) call into this half; the connector definitions themselves come from
[@clawboo/connector-catalog](/reference/packages/connector-catalog).

- **Sessions.** `connectStdioConnector(spec)` spawns a local server and `connectHttpConnector(spec)` dials a remote
  one. Both return a `ConnectorSession` that lists tools and calls them, and both throw
  `ConnectorHandshakeError` when the server never completes the MCP handshake.
- **Time budgets.** The handshake, each tool-list page and each tool call have separate timeouts
  (`DEFAULT_HANDSHAKE_TIMEOUT_MS`, `DEFAULT_LIST_TIMEOUT_MS`, `DEFAULT_CALL_TIMEOUT_MS`). The handshake budget is the
  generous one, because a cold `npx` install happens inside it. Discovery stops at `MAX_CONNECTOR_TOOLS` tools.
- **Results.** `flattenContent` turns an MCP result into text for the model, and images ride along separately.
- **Environment.** `connectorChildEnv` builds a stdio connector's environment from an empty set, the few variables
  a process needs to start, the proxy settings and npm's prefix, cache and update check in either spelling
  (`CONNECTOR_ENV_ALLOWLIST`), and the credentials you gave that connector, so it never inherits your provider keys
  or npm credentials. It sets `npm_config_update_notifier=false` unless that is already set; pass
  `npmUpdateCheck: 'inherit'` to leave it as the operator configured it, as approved shell commands do.
  This closes the environment only. It is not a sandbox: the connector still runs as your user and can read your
  files.

Remote connectors sign in with OAuth 2.1, discovered from the server rather than configured per provider:

<Steps>

<Step title="Discover">

An unauthenticated request returns `401` with a `WWW-Authenticate` header. `resourceMetadataUrl` reads it,
`discoverResourceMetadata` fetches the protected-resource metadata (RFC 9728), and `discoverAuthServer` fetches the
authorization server's metadata (RFC 8414).

</Step>

<Step title="Register">

`registerClient` registers this install as a client through dynamic client registration (RFC 7591), with the
loopback redirect it is about to listen on. Clawboo ships no client secret, so an authorization server without a
registration endpoint cannot be used; the catalog marks such providers with `needsPreregisteredApp`.

</Step>

<Step title="Authorize and exchange">

`createPkce` makes an S256 challenge, `buildAuthorizeUrl` builds the sign-in URL, and `exchangeCode` and
`refreshToken` talk to the token endpoint.

</Step>

</Steps>

Every endpoint must be `https` unless it is on this machine, and a host that resolves to a private or link-local
address is refused, so a connector cannot point Clawboo at your local network. `isLoopbackUrl` lets the flow tell
an authorization server you run yourself from one a remote server named.

## Add or change a tool

<Steps>

<Step title="Add the tool definition">

Each server builds its tools as plain definitions (`name`, `description`, a zod `inputSchema`, a `handler`) and
passes them to `buildServer` in `src/shared.ts`. `buildServer` validates arguments with zod and converts the schema
to JSON Schema itself. The servers use the SDK's low-level `Server` API, because the high-level per-tool type
inference exhausts the TypeScript compiler's memory once a server has about a dozen tools.

</Step>

<Step title="Keep data access in the database package">

Put the query or write in a `@clawboo/db` repository function and call it from the handler, so the REST routes
and the other servers can reuse it.

</Step>

<Step title="Decide who may call it">

If an argument names an agent, a team or a room, take it from the bound scope instead of trusting the model, and
decide what an unverified caller gets. Tasks lists its identity tools in `IDENTITY_TOOL_NAMES` for this reason.
Return a refusal the model must not retry as an error result (`textResult(message, true)`).

</Step>

<Step title="Test and document it">

Run `pnpm --filter @clawboo/mcp test`; the suite includes the shared server contract and the unverified-caller
cases. Then add the tool to [MCP tools](/reference/mcp-tools). You should see it in a client's `tools/list`, for
example from the stdio bin with `CLAWBOO_DB_PATH` set.

</Step>

</Steps>

## Related

- [MCP tools](/reference/mcp-tools): every tool's inputs, outputs and limits.
- [MCP servers](/operating/mcp-servers): attach an outside agent, and the attach token in practice.
- [@clawboo/db](/reference/packages/db): the repositories behind every handler.
- [Add a connector](/reference/packages/connector-catalog): the definitions the connector client launches.
- [@clawboo/gateway-client](/reference/packages/gateway-client): the access gate that checks the attach token.
