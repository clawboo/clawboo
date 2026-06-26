---
title: '@clawboo/mcp'
description: Protocol adapters exposing Clawboo's Tasks / Memory / Tools / TeamChat MCP servers over stdio and in-process Streamable HTTP.
---

**Version** `0.1.0` · **Purity** server-only · **Purpose** thin MCP protocol adapters over the `@clawboo/db` service cores, served over stdio bins + in-process Streamable HTTP.

- **Workspace deps**: `@clawboo/db`
- **External deps**: `@modelcontextprotocol/sdk` (pinned `1.29.0`), `zod`

The package is the protocol layer of the MCP quartet (Tasks · Memory · Tools · TeamChat). Each server is a low-level SDK `Server` built from `@clawboo/db` data-access cores. The same SQLite file is the cross-process bus, so a stdio bin spawned by an external runtime and the in-process Express server read/write the same board / memory / tools / team_chat store.

<Info>
Servers use the SDK's low-level `Server` + `setRequestHandler` API, **not** `McpServer.registerTool`; the high-level API's per-tool zod-generic inference OOMs `tsc` and the `tsup dts` build once a server has ~12 tools. Every SDK touchpoint lives in `shared.ts` (`buildServer` + a self-contained zod→JSON-Schema converter).
</Info>

The bins ship as four CLI executables: `clawboo-mcp-tasks`, `clawboo-mcp-memory`, `clawboo-mcp-tools`, `clawboo-mcp-teamchat`.

## Public API

Everything below is re-exported from the `.` barrel (`src/index.ts`).

### Functions

| Export                         | Signature                                                                       | Contract                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createTasksServer`            | `(db: ClawbooDb) => Server`                                                     | Build the Tasks MCP server (12 tools) over the durable board repository. Atomic claim surfaces a conflict as a tool-error the model must not retry.                                                                                  |
| `createMemoryServer`           | `(db, embed?: EmbeddingProvider \| null, opts?: MemoryServerOptions) => Server` | Build the Memory MCP server (`memory_save` / `memory_search` / `memory_browse`) over `SqliteMemoryStore`. `opts.boundScope` makes the run's scope authoritative (anti-mis-tag).                                                      |
| `createToolsServer`            | `(db, opts?: ToolsServerOptions) => Server`                                     | Build the Tools MCP broker server. Lists only **available** tools (a hidden tool is absent from `tools/list`); every call routes through the broker (inspector chain → approval → execute → compaction → audit).                     |
| `createTeamChatServer`         | `(db, opts?: TeamChatServerOptions) => Server`                                  | Build the TeamChat MCP server (`team_chat_post` / `team_chat_subscribe`) over the `team_chat` substrate. `opts.boundIdentity` makes author + room authoritative (anti-spoof).                                                        |
| `formatPeerPost`               | `(post: PeerPostLike) => string`                                                | Wrap a room post as non-user inter-session evidence (`[Inter-session message · … · isUser=false]`). Defangs an embedded forged header and quote-prefixes the body. The single source of truth for peer-as-evidence tagging.          |
| `runStdioServer`               | `(server: Server) => Promise<void>`                                             | Serve a built server over stdio (`StdioServerTransport`). The consuming runtime owns the process lifecycle.                                                                                                                          |
| `createStreamableHttpHandlers` | `(createServer: (req?: IncomingMessage) => Server) => McpHttpHandlers`          | Build POST/GET/DELETE handlers for one server factory. A fresh server + transport is created per MCP session (on `initialize`); the initialize request is handed to the factory so a server can bind per-session state from the URL. |
| `probeServer`                  | `(server: Server) => Promise<number>`                                           | Liveness probe: connect an in-memory `Client`, `tools/list`, resolve to the tool count, close both ends in `finally`. Throws on failure.                                                                                             |
| `connectInMemoryClient`        | `(server: Server, name?: string) => Promise<InMemoryMcpClient>`                 | Connect a long-lived in-memory `Client` to a server (the in-process consumption path for the native runtime). `close()` is idempotent and never throws.                                                                              |
| `buildAttachConfig`            | `(input: AttachConfigInput) => AttachConfig`                                    | Produce the per-runtime + per-transport attach snippet (copy-pasteable command/config block + structured form). Pure, no SDK.                                                                                                        |
| `mcpHttpUrl`                   | `(httpBaseUrl: string, server: McpServerName, scope?: AttachScope) => string`   | The HTTP attach URL for one server. Appends scope query params only for `memory` (`scopeTeamId`/`scopeAgentId`/`scopeTenantId`) and `teamchat` (`roomTeamId`/`postAuthorAgentId`); `tasks`/`tools` stay bare.                        |

### Types & interfaces

| Export                  | Kind      | Contract                                                                                                                                                                      |
| ----------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolsServerOptions`    | interface | `{ availability?, agentId?, broker? }`, broker context for `createToolsServer` (which tools register, audit identity, provenance/approval/compaction knobs).                  |
| `TeamChatServerOptions` | interface | `{ boundIdentity?: TeamChatBoundIdentity, onPost?: (post: DbTeamChat) => void }`, anti-spoof binding + a best-effort obs emit hook.                                           |
| `TeamChatBoundIdentity` | interface | `{ agentId, teamId, roomId }`, the runtime's identity bound by clawboo at attach time (URL / closure).                                                                        |
| `PeerPostLike`          | interface | `{ authorAgentId, body, kind: string, seq: number }`, the input shape `formatPeerPost` wraps.                                                                                 |
| `McpHttpHandlers`       | interface | `{ handlePost(req, res, body), handleSessionRequest(req, res) }`, typed against `node:http` (Express req/res are assignable).                                                 |
| `InMemoryMcpClient`     | interface | `{ listTools(): Promise<McpToolInfo[]>, callTool(name, args): Promise<McpCallOutcome>, close(): Promise<void> }`, minimal structural client surface for in-process consumers. |
| `McpCallOutcome`        | interface | `{ output: string, isError: boolean, denied?: string }`, `denied` is read from the result's `_meta.denied` (a broker policy-denial reason).                                   |
| `McpToolInfo`           | interface | `{ name: string, description?: string, inputSchema?: Record<string, unknown> }`, one tool as served by `tools/list`.                                                          |
| `AttachConfig`          | interface | `{ id: string, transport: McpTransport, snippet: string, structured: Record<string, unknown> }`, the result of `buildAttachConfig`.                                           |
| `AttachConfigInput`     | interface | `{ runtime, server, transport, binPath?, dbPath?, httpBaseUrl?, scope? }`, input for `buildAttachConfig`.                                                                     |
| `AttachScope`           | interface | `{ teamId?, agentId?, tenantId? }`, the run's visibility (Memory) + room/author binding (TeamChat).                                                                           |
| `McpRuntime`            | type      | `'claude-code' \| 'codex' \| 'openclaw'`, runtimes that attach via their own config (HTTP/stdio snippets).                                                                    |
| `McpServerName`         | type      | `'tasks' \| 'memory' \| 'tools' \| 'teamchat'`.                                                                                                                               |
| `McpTransport`          | type      | `'stdio' \| 'http'`.                                                                                                                                                          |

### Constants

| Export               | Value                                               | Contract                                                        |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `MCP_SERVER_NAMES`   | `readonly ['tasks', 'memory', 'tools', 'teamchat']` | The canonical server-name list; drives per-runtime auto-attach. |
| `MCP_SERVER_VERSION` | `'0.1.0'`                                           | The `version` every built `Server` advertises.                  |

<Note>
The `Server` type (`@modelcontextprotocol/sdk/server/index.js`) is re-exported from `shared.ts` for internal use but is **not** part of the `.` barrel.
</Note>

### The four servers' tools

`createTasksServer` (name `clawboo-tasks`): `list_tasks`, `get_task`, `create_task`, `create_subtask`, `claim_task`, `assign_task`, `release_task`, `update_task_status`, `block_task`, `unblock_task`, `add_comment`, `link_task`.

`createMemoryServer` (name `clawboo-memory`): `memory_save`, `memory_search` (mode `fts | vector | hybrid`), `memory_browse`.

`createToolsServer` (name `clawboo-tools`): the broker's built-in registry, filtered to available descriptors (`echo`/`note`/`web_search`/`delete_path`, availability-gated).

`createTeamChatServer` (name `clawboo-teamchat`): `team_chat_post`, `team_chat_subscribe`.

<Info>
`claim_task` / `assign_task` return a tool-error on conflict (`claim failed: <reason>`). A conflict means another agent won the atomic claim; the model must **not** retry.
</Info>

## Used by

Only `apps/web` depends on `@clawboo/mcp` (no other package does; a `@clawboo/db` comment merely references it). Server-side consumers include the MCP REST/transport route (`server/api/mcp.ts`), the OpenClaw agent-source MCP registration, the boot probe and liveness supervisor (`bootProbe.ts`, `mcpSupervisor.ts`), the runtime drivers (`claudeCodeDriver`, `codexDriver`, `hermesDriver`), the native in-process bridge (`runtimes/native/mcpBridge.ts`), the capability sources (`capabilitySource/{claudeCode,codex}.ts`), the team-chat dispatcher (`teamChat/dispatchChatTurn.ts`), and the bin bundler (`tsup.mcp-bins.config.ts`).

## Source

`packages/mcp/src/index.ts` (barrel). Servers in `src/{tasks,memory,tools,teamchat}/server.ts`; transports in `src/{stdio,http}.ts`; clients in `src/{probe,inMemoryClient}.ts`; attach config in `src/config.ts`; SDK helpers in `src/shared.ts`; bins in `src/bin/`.

## See also

- [@clawboo/db](/reference/packages/db), the service cores the servers adapt (board, memory store, tools broker, team_chat).
- [MCP tools reference](/reference/mcp-tools), the full tool list + zod input shapes.
- [Tools & MCP REST](/reference/rest-api/tools-and-mcp), `/api/mcp/*` transport + attach-config routes.
- [MCP servers as teammates](/operating/mcp-servers), attaching the servers from an external runtime.
