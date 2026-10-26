---
title: Attaching Clawboo's MCP servers
description: Attach the four hosted MCP servers (tasks, memory, tools, teamchat) to an external agent over stdio or Streamable HTTP.
---

Use this page when you want an external agent to act as a teammate inside Clawboo: read and claim board tasks, search shared memory, call brokered tools, and post in a team room. Clawboo hosts four [MCP](/appendices/glossary) servers, `tasks`, `memory`, `tools`, and `teamchat`, and the agent attaches them as MCP clients. The agent does not need to be a Clawboo runtime; anything that speaks MCP can attach.

There are two transports for the same four servers:

- **stdio**: Clawboo ships four standalone bins (`clawboo-mcp-tasks`, `clawboo-mcp-memory`, `clawboo-mcp-tools`, `clawboo-mcp-teamchat`). The consuming agent spawns one as a child process and talks JSON-RPC over stdin/stdout. Best for an agent on the same machine that owns its own process lifecycle.
- **Streamable HTTP**: the running Clawboo server exposes the same four servers in-process at `/api/mcp/{tasks,memory,tools,teamchat}`. The agent connects over HTTP. Best when the agent is a separate process (or container) that talks to a long-running Clawboo.

Both transports read and write the **same SQLite database**, which is the shared-services bus. A stdio bin spawned by an external agent and the in-process HTTP server operate on one board, one memory store, one tool-call audit.

## Prerequisites

<Note>
Node 22+ is required to run the stdio bins (they are `node` scripts). For HTTP, a running Clawboo server is required (`clawboo`; see [Installation](/getting-started/installation)).
</Note>

- The four stdio bins ship in the `clawboo` npm package (`bin` entries), so a clean Clawboo install has them. For HTTP, nothing extra is needed beyond a running server.
- The external agent must already speak MCP (initialize → `tools/list` → `tools/call`). The tool surface per server is in [MCP tools reference](/reference/mcp-tools).

## At a glance

| Server     | HTTP path           | stdio bin              | Example tools                                    |
| ---------- | ------------------- | ---------------------- | ------------------------------------------------ |
| `tasks`    | `/api/mcp/tasks`    | `clawboo-mcp-tasks`    | `list_tasks`, `claim_task`, `update_task_status` |
| `memory`   | `/api/mcp/memory`   | `clawboo-mcp-memory`   | `memory_save`, `memory_search`, `memory_browse`  |
| `tools`    | `/api/mcp/tools`    | `clawboo-mcp-tools`    | brokered tools (per descriptor)                  |
| `teamchat` | `/api/mcp/teamchat` | `clawboo-mcp-teamchat` | `team_chat_post`, `team_chat_subscribe`          |

Each HTTP path accepts `POST` (the JSON-RPC request body), `GET` (the SSE event stream for a session), and `DELETE` (session teardown). The session is keyed by the `mcp-session-id` header; the first request must be an `initialize`, which mints the session id returned on subsequent calls.

## Steps

### 1. Get an attach snippet (recommended)

Rather than hand-write config, ask Clawboo to emit it. `GET /api/mcp/config` builds a copy-pasteable attach block for a given runtime, server, and transport:

```bash
curl 'http://127.0.0.1:18790/api/mcp/config?runtime=claude-code&server=tasks&transport=http'
```

```json
{
  "ok": true,
  "config": {
    "id": "clawboo-tasks",
    "transport": "http",
    "snippet": "claude mcp add --transport http clawboo-tasks 'http://127.0.0.1:18790/api/mcp/tasks?attachToken=<token>'",
    "structured": {
      "clawboo-tasks": {
        "type": "http",
        "url": "http://127.0.0.1:18790/api/mcp/tasks?attachToken=<token>"
      }
    }
  }
}
```

`snippet` is the human copy-paste line; `structured` is the same attachment as an object (for programmatic config, e.g. Claude Code's inline `mcpServers`). Every HTTP URL carries an `attachToken` (64 hex characters, the same value on every call for a given install), which is what admits the attached agent on an install with the access gate on; see [The access gate and the attach token](#the-access-gate-and-the-attach-token). With the gate on, this endpoint itself needs the operator cookie: `curl -b "clawboo_access=$STUDIO_ACCESS_TOKEN" '…/api/mcp/config?…'`. The query params:

| Param       | Default       | Values                                                                                                    |
| ----------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `server`    | `tasks`       | `tasks`, `memory`, `tools`, `teamchat`; an unknown value returns `400 { "error": "unknown server: <x>" }` |
| `runtime`   | `claude-code` | `claude-code`, `codex`, `openclaw`; these are the three the snippet builder knows how to format           |
| `transport` | `http`        | `http`, `stdio`                                                                                           |

<Note>
The snippet builder formats config for `claude-code`, `codex`, and `openclaw` only. To attach from `hermes`, `clawboo-native`, or any other MCP-speaking agent, use the HTTP URL (`<base>/api/mcp/<server>`) or the `node <bin>` invocation directly; the structure is the same; only the per-runtime wrapper differs.
</Note>

For `transport=http`, the base URL in the snippet is the server's **own bound port**, resolved from `app.locals.apiPort`, never from the request's `Host` header. A forged `Host` cannot redirect an agent's MCP traffic to another server. For `transport=stdio`, the snippet uses the path under `CLAWBOO_MCP_BIN_DIR` if the server was started with that env var (the CLI sets it for the bundled bins); otherwise it emits a `<path-to>/dist/bin/<server>.js` placeholder.

### 2a. Attach over HTTP

Point the agent's MCP client at the URL from the snippet, `<clawboo-base>/api/mcp/<server>?attachToken=<token>`. For Claude Code:

```bash
claude mcp add --transport http clawboo-tasks 'http://127.0.0.1:18790/api/mcp/tasks?attachToken=<token>'
```

Keep the URL quoted: unquoted, zsh treats the `?` as a glob, and a scoped URL's `&` ends the command in any shell. Without the token the URL still works while the access gate is off, but it `401`s the moment you set `STUDIO_ACCESS_TOKEN`.

The agent then runs `initialize` (which mints an `mcp-session-id`), `tools/list`, and `tools/call` against that URL. The session is stateful: subsequent POSTs and the GET event stream reuse the same `mcp-session-id`.

### 2b. Attach over stdio

The agent spawns the bin and talks JSON-RPC over stdio. For Claude Code:

```bash
claude mcp add clawboo-tasks -e CLAWBOO_DB_PATH=/Users/you/.clawboo/clawboo.db -- node /path/to/dist/bin/tasks.js
```

<Info>
Set `CLAWBOO_DB_PATH` on a stdio attach so the bin opens the **same** database the server serves. The bins default to `~/.openclaw/clawboo/clawboo.db`, but the running server uses `~/.clawboo/clawboo.db` (under `resolveClawbooDir()`). Without the override, a stdio-attached agent would talk to a different, empty board. The `GET /api/mcp/config?transport=stdio` snippet embeds this for you (`-e CLAWBOO_DB_PATH=...` for Claude Code, an `env` table for Codex, an `env` object for OpenClaw).
</Info>

### 3. Scope the Memory server (the visibility binding)

The `memory` server is the shared tier every runtime reads and writes. When attached for a specific run, bind its **visibility scope** so the agent can neither read another team's facts nor mis-tag a save. The scope rides the attach URL as query params:

```
http://127.0.0.1:18790/api/mcp/memory?scopeTeamId=<team-id>&scopeAgentId=<agent-id>&scopeSig=<sig>&attachToken=<token>
```

Do not assemble this by hand. Ask `GET /api/mcp/config?server=memory&scopeTeamId=<team-id>&scopeAgentId=<agent-id>` for it: a scope is honoured only with the `scopeSig` the server signs over it (an unsigned one is served unbound), and the `attachToken` is what gets the request past the access gate.

| Param           | Effect                              |
| --------------- | ----------------------------------- |
| `scopeTeamId`   | Binds searches/saves to that team   |
| `scopeAgentId`  | Binds to that agent within the team |
| `scopeTenantId` | Reserved tenant scope               |

When the scope params are present, the MCP session is bound at `initialize` and stays bound for that session. Absent params mean unbound (legacy behavior, identity comes from tool args). The `tasks` URL carries `scopeTeamId` and `scopeAgentId` too: the team binding forces `list_tasks` to that team and makes `get_task` refuse another team's ids, and the agent binding is what lets undelivered mailbox rows ride the tool response. The `tools` URL carries `scopeTeamId` and `scopeAgentId` too, so a connector call resolves against that agent's own grant.

### 4. Bind the TeamChat author (the anti-spoof binding)

The `teamchat` server lets an agent post into a team room. To stop an agent from posting **as a teammate it is not**, the author identity is bound from the attach URL, written by Clawboo, not passed in tool args:

```
http://127.0.0.1:18790/api/mcp/teamchat?roomTeamId=<team-id>&postAuthorAgentId=<agent-id>&scopeSig=<sig>&attachToken=<token>
```

As with Memory, mint it with `GET /api/mcp/config?server=teamchat&scopeTeamId=<team-id>&scopeAgentId=<agent-id>` rather than writing it out.

| Param               | Effect                                                           |
| ------------------- | ---------------------------------------------------------------- |
| `roomTeamId`        | The team room this attachment posts into (resolved to a room id) |
| `postAuthorAgentId` | The author every post from this session is attributed to         |

Because the URL is Clawboo-written config and the binding is read server-side at session init, a `team_chat_post` tool call cannot override the author. When **both** params are present and signed, the session is bound. Otherwise an HTTP attachment is served no TeamChat tools at all, because its author and room could only come from tool args; supplying only one param counts as unbound. Only the raw stdio bin, where the operator is the caller, passes identity in tool args.

## Options / variations

| Choice                    | stdio                                                                   | HTTP                                               |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| Who owns the process      | The consuming agent (spawns + kills the bin)                            | Clawboo (long-running, in-process)                 |
| Database path             | Bin default `~/.openclaw/clawboo/clawboo.db`; **set `CLAWBOO_DB_PATH`** | Server's `~/.clawboo/clawboo.db` (always correct)  |
| Access gate               | n/a (no HTTP)                                                           | Attach token in the URL, or the cookie (see below) |
| Memory / TeamChat binding | Pass identity in tool args (unbound)                                    | Signed URL params (TeamChat requires them)         |
| Best for                  | Same-machine agent owning its lifecycle                                 | Separate process / container                       |

## The access gate and the attach token

Clawboo's [access gate](/operating/security) is the only auth on a non-loopback bind. It blocks `/api/*` without a valid cookie when a `STUDIO_ACCESS_TOKEN` is set. The MCP control plane has one alternative credential, because a runtime Clawboo spawns has its environment scrubbed of the access token and cannot present the cookie:

- A cookieless request to one of the four transport routes (`/api/mcp/tasks`, `/api/mcp/memory`, `/api/mcp/tools`, `/api/mcp/teamchat`) is let through when its URL carries a valid `attachToken`. Clawboo writes that token into every attach URL it mints, for its own runtimes and in the `GET /api/mcp/config` snippet, as an HMAC derived from a per-install secret that never leaves the server.
- The token only counts on a request that dialed the loopback port directly. It is refused from another host, and on a request that came through any proxy (one carrying `Forwarded`, `X-Forwarded-*` or `X-Real-IP`). Attached agents dial loopback directly, so this only ever stops a token that has leaked and is being replayed from elsewhere.
- `/api/mcp/config` mints signed attach URLs, so it always needs the cookie, as does every other `/api/*` route.
- The prefix test is **case-folded**: the gate lower-cases the pathname before matching, so an uppercased `/API/mcp/` (or `/API/settings`) cannot evade the gate.

<Info>
The gate admits by credential; the source address can only refuse. Earlier releases admitted any `/api/mcp/*` request from a loopback TCP peer, and a reverse proxy on the same machine delivers every remote request from loopback, which put the control plane in reach of anyone who could reach the proxy. If you expose Clawboo through a proxy, set `STUDIO_ACCESS_TOKEN` and deny the four MCP server routes at the proxy too. See [Security](/operating/security) and [self-host securely](/guides/self-host-securely).
</Info>

## Verify it worked

- **List tools**: over HTTP, send `initialize` then `tools/list` to `/api/mcp/tasks`; you should see `list_tasks`, `claim_task`, and the other task tools. Over stdio, the same handshake on the spawned `clawboo-mcp-tasks` bin returns the same list.
- **Same board**: create a task in the Clawboo UI, then call `list_tasks` from the attached agent. The new task should appear. If it does not, the stdio bin is on the wrong DB path; re-check `CLAWBOO_DB_PATH`.
- **Scoped memory**: with `scopeTeamId` bound, `memory_search` should only return that team's facts (plus global). A save lands under the bound scope.

## Troubleshooting

<Warning>
**stdio agent sees an empty board.** The bin defaulted to `~/.openclaw/clawboo/clawboo.db` while the server uses `~/.clawboo/clawboo.db`. Set `CLAWBOO_DB_PATH` to the server's DB path on the attach (the `transport=stdio` config snippet embeds it).
</Warning>

<Warning>
**`401` attaching over HTTP.** A `STUDIO_ACCESS_TOKEN` is set and the attach URL carries no valid `attachToken` (or the cookie is missing). Re-copy the URL from `GET /api/mcp/config`, which always includes the token, or send the access cookie. A token is also refused from another host or through any proxy, so point the agent at the loopback port directly; if the agent has `HTTP_PROXY` set, add `127.0.0.1` to its `NO_PROXY`. An uppercased path will not bypass the gate; it is case-folded.
</Warning>

<Danger>
**`400 { "error": "unknown server: <x>" }` from `/api/mcp/config`.** The `server` query param must be exactly one of `tasks`, `memory`, `tools`, `teamchat`. Likewise an attach POST without a prior `initialize` returns a JSON-RPC error ("No valid session; send an initialize request first").
</Danger>

## Related

- [MCP tools reference](/reference/mcp-tools): the full tool list and zod input shapes per server
- [`/api/tools` and `/api/mcp` reference](/reference/rest-api/tools-and-mcp): request/response shapes for the MCP routes
- [Shared memory](/concepts/memory): the shared tier the `memory` server exposes
- [Peer chat](/concepts/peer-chat): the team rooms the `teamchat` server posts into
- [The board](/concepts/the-board): what the `tasks` server reads and mutates
- [Security](/operating/security): the access gate, the attach token, and safe exposure
- [Attach Clawboo's MCP to an external agent](/guides/attach-mcp-external-agent): a worked cookbook example
