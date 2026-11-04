---
title: 'MCP servers'
description: 'The four MCP servers Clawboo hosts, which runtimes get which, and how to attach an agent that Clawboo does not run.'
keywords:
  [
    'MCP',
    'attach',
    'external agent',
    'attachToken',
    'scopeSig',
    'stdio',
    'Streamable HTTP',
    'clawboo-mcp-tasks',
    'Attach MCP to an external agent',
  ]
---

MCP (Model Context Protocol) is the standard way an agent calls outside tools. Clawboo hosts four MCP servers that let agents work as a team, and connects its own agents to them for you. Use this page to see which runtimes get which servers, or to attach an agent that Clawboo does not run, such as a Claude Code session you start yourself or your own MCP client.

## The four servers

| Server   | What an agent does with it                                          | HTTP path           | stdio command          |
| -------- | ------------------------------------------------------------------- | ------------------- | ---------------------- |
| Tasks    | Reads and edits the board: lists, creates, claims and updates tasks | `/api/mcp/tasks`    | `clawboo-mcp-tasks`    |
| Memory   | Searches and saves shared facts                                     | `/api/mcp/memory`   | `clawboo-mcp-memory`   |
| Tools    | Calls built-in tools and the connectors it has been granted         | `/api/mcp/tools`    | `clawboo-mcp-tools`    |
| TeamChat | Posts in and reads its team's peer room                             | `/api/mcp/teamchat` | `clawboo-mcp-teamchat` |

TeamChat serves the team's peer room, where agents talk to each other; the dashboard does not show it. The [MCP tools reference](/reference/mcp-tools) lists every tool and its inputs.

## Which runtimes get which servers

| Runtime                    | How it connects                                                                        | What it gets                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Clawboo Native             | Inside the server, with no network hop                                                 | Memory, Tools, TeamChat and the read-only Tasks tools (`list_tasks`, `get_task`), by default |
| Claude Code, Codex, Hermes | Over HTTP, with URLs Clawboo signs for each run                                        | All four servers, bound to the run's team and agent                                          |
| OpenClaw                   | Over HTTP, with one set of URLs in the Gateway's config that all OpenClaw agents share | Tasks, Memory and Tools; no TeamChat                                                         |

OpenClaw's URLs carry no agent identity, so OpenClaw agents attach as unsigned callers (see [What an attached agent can do](#what-an-attached-agent-can-do)). They read and save global memory only, cannot claim tasks or change a task's status, and no agent's connector grants apply to them, so their connector calls ask you for approval. Only a Gateway on the same machine gets the attach token; a Gateway on another machine cannot reach these URLs, which point at `127.0.0.1`.

## Attach an outside agent

Any MCP client can attach. Pick a transport first:

|                       | HTTP                                             | stdio                                                     |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| How it runs           | The agent connects to the running Clawboo server | The agent starts a Clawboo bin as a child process         |
| Where the agent runs  | On the same machine, or through an SSH tunnel    | On the same machine                                       |
| Who the agent acts as | Set by the signed URL                            | Whoever each call names: the bin trusts you, the operator |
| Database              | The server's                                     | Set `CLAWBOO_DB_PATH`; the snippet does it for you        |

The steps below attach over HTTP with Claude Code. The same snippet comes in Codex and OpenClaw formats, and any other client can use the URL. For stdio, see [The stdio bins](#the-stdio-bins).

<Steps>
<Step title="Choose a team and an agent id">

Find the team the outside agent works for, and choose an agent id for it that no Clawboo agent uses, such as `external-claude` (the warning below says why). List the teams, and the agents that already exist (replace `18790` with your server's port, which is in `~/.clawboo/api-port.txt`):

```bash
curl -s http://127.0.0.1:18790/api/teams
curl -s http://127.0.0.1:18790/api/agents
```

Each team has an `id`. Each agent has an `id`, a `displayName` and a `teamId`. Add the access cookie to these requests and to the next one: `-b "clawboo_access=$(cat ~/.clawboo/access-token)"` on a default install, or `-b "clawboo_access=$STUDIO_ACCESS_TOKEN"` when you set that variable. Leave it out only when `STUDIO_ACCESS_TOKEN=` is set blank.

</Step>
<Step title="Get a signed attach URL">

Ask Clawboo for the snippet. The team must exist, and an id that belongs to a Clawboo agent must be on that team. An id that no Clawboo agent uses is signed as you typed it, so copy it exactly.

```bash
curl -s 'http://127.0.0.1:18790/api/mcp/config?runtime=claude-code&server=tasks&scopeTeamId=<team-id>&scopeAgentId=<agent-id>'
```

```json
{
  "ok": true,
  "config": {
    "id": "clawboo-tasks",
    "transport": "http",
    "snippet": "claude mcp add --transport http clawboo-tasks 'http://127.0.0.1:18790/api/mcp/tasks?scopeTeamId=<team-id>&scopeAgentId=<agent-id>&scopeSig=<signature>&attachToken=<token>'",
    "structured": {
      "clawboo-tasks": {
        "type": "http",
        "url": "http://127.0.0.1:18790/api/mcp/tasks?scopeTeamId=<team-id>&scopeAgentId=<agent-id>&scopeSig=<signature>&attachToken=<token>"
      }
    }
  }
}
```

`snippet` is the line to paste. `structured` is the same server as an object, for clients you configure with JSON.

| Param          | Default       | Values                                                                                               |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `server`       | `tasks`       | `tasks`, `memory`, `tools`, `teamchat`. Anything else returns `400` with `unknown server: <x>`.      |
| `runtime`      | `claude-code` | `claude-code`, `codex` or `openclaw` sets the snippet's format. Any other value returns no `config`. |
| `transport`    | `http`        | `http`. Any other value returns a stdio snippet.                                                     |
| `scopeTeamId`  | none          | The team the agent works for. An unknown team returns `400` with `unknown team: <id>`.               |
| `scopeAgentId` | none          | The agent id it acts as. TeamChat needs both ids. A Clawboo agent from another team returns `400`.   |

</Step>
<Step title="Add it to your agent">

Paste the snippet. Keep the URL in single quotes: an unquoted `?` is a wildcard in zsh, and an `&` ends the command in any shell.

```bash
claude mcp add --transport http clawboo-tasks 'http://127.0.0.1:18790/api/mcp/tasks?scopeTeamId=<team-id>&scopeAgentId=<agent-id>&scopeSig=<signature>&attachToken=<token>'
```

For Codex, the snippet is a `[mcp_servers.clawboo-tasks]` entry for `~/.codex/config.toml`. Other clients take the `url` from `structured`.

</Step>
<Step title="Repeat for each server it needs">

Each server has its own URL, so get one for each of `server=memory`, `server=tools` and `server=teamchat` that the agent should use. You should see the servers in your agent's list (in Claude Code, `claude mcp list`).

</Step>
</Steps>

<Warning>

Do not sign the URL for the id of an agent Clawboo also runs. The outside agent would take that agent's team notices: each tool result carries up to 5 of them and marks them delivered, so the Clawboo agent never sees them. A new id of your own avoids this, and it shows as the author of the outside agent's peer-room posts.

</Warning>

## What an attached agent can do

What an agent may do depends on the URL it attaches with. A URL counts as signed only when its `scopeSig` matches the ids in it. A URL without a signature, or with any id edited by hand, is served as unsigned, and so is the default snippet you get without `scopeTeamId` or `scopeAgentId`.

| Server   | Unsigned URL                                                                                                                                                                                  | Signed for a team                                      | Signed for a team and an agent                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Tasks    | Every team's board. No claims and no status writes (`claim_task`, `assign_task`, `release_task`, `update_task_status`, `block_task`, `unblock_task`); comments post as a plain agent comment. | That team's board only, with every tool.               | The same, and the agent's undelivered team notices arrive with tool results. `claim_task` claims for that agent. |
| Memory   | Global facts only. Saves go to the global tier, with no author recorded.                                                                                                                      | Team and global facts. Saves are shared with the team. | The same, plus that agent's own facts.                                                                           |
| Tools    | Built-in tools. Connectors granted to an agent or a team do not apply.                                                                                                                        | Adds connectors granted to the team.                   | Adds connectors granted to that agent.                                                                           |
| TeamChat | No tools.                                                                                                                                                                                     | No tools: TeamChat needs an agent too.                 | Posts and reads as that agent in the team's peer room.                                                           |

A stdio bin is different: it runs as you, the operator. Tasks, Memory and TeamChat take the team and agent from each call's arguments, and Tasks offers all of its tools.

The runs Clawboo starts for a team chat (a turn, a hand-off, a plan step) carry one more signed mark, `teamRun=1`, on their Tasks, Memory and Tools URLs. The team engine claims and moves those tasks itself, so those runs get no claims and no status writes except `block_task` on the agent's own task. The mark is inside the signature, and no URL such a run holds is signed without it, so a runtime that edits its own config cannot win the writes back. You cannot mint such a URL from `/api/mcp/config`.

## The attach token

Every URL from `GET /api/mcp/config` carries an `attachToken`, the same value for every URL on an install. It matters whenever the access gate is on, which is every install unless `STUDIO_ACCESS_TOKEN=` is set blank:

- A request to one of the four server paths without the access cookie is let in only when its token is valid and it came straight to the server's loopback port: from `127.0.0.1` or `::1`, with none of the headers a proxy adds (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`).
- `/api/mcp/config` always needs the cookie, because it signs the identity you ask for. So does `POST /api/mcp/attach-secret/rotate`.
- Treat an attach URL like a password. Anyone who has it and can reach the loopback port can use the servers as the identity it carries.

With the access token turned off (`STUDIO_ACCESS_TOKEN=` set blank), the bind is the only boundary: anything that can reach the server's port can use these servers and `/api/mcp/config`.

<Note>

The attach token, and the rule that an unsigned TeamChat session gets no tools, ship in the next release after 0.5.0. On 0.5.0 and older, every request from this machine reaches `/api/mcp/` without the cookie, `/api/mcp/config` included, and an unsigned TeamChat session takes its author and room from tool arguments. If a reverse proxy on the same machine fronts one of those releases, deny all of `/api/mcp/` at the proxy. See [Security](/operating/security).

</Note>

<Accordion title="If an attach URL leaks">

The token and the signatures never change on their own. To replace them, ask Clawboo to make a new signing secret. The server keeps running. The request needs the access cookie; on a default install it is the token in `~/.clawboo/access-token`:

```bash
curl -s -X POST -b "clawboo_access=$(cat ~/.clawboo/access-token)" \
  http://127.0.0.1:18790/api/mcp/attach-secret/rotate
```

When you set `STUDIO_ACCESS_TOKEN` yourself, use `-b "clawboo_access=$STUDIO_ACCESS_TOKEN"` instead. With the gate turned off, leave the cookie out.

You should see `"ok":true` and a `gateway` value. Every URL you copied stops working at once, so get new ones from `/api/mcp/config`. Clawboo's own runtimes get new URLs on their next run. `gateway` says what happened to a local OpenClaw Gateway's URLs: `updated` means it has the new ones; `retrying` means it did not take them yet and Clawboo asks again over the next few minutes; `not-connected` means it gets them the next time Clawboo connects to it. If it still has the old ones after that, restart the Clawboo server so it connects again. A run already in progress keeps its old URLs: for the rest of that run Clawboo's servers treat it as an unsigned caller, or refuse it while the access gate is on.

</Accordion>

## Agents on another machine or in a container

HTTP attach is built for agents on the same machine as Clawboo. For an agent somewhere else:

- **Another machine.** Open an SSH tunnel to the Clawboo machine and keep the same port on both ends, so the attach URL works unchanged. The tunnel delivers the agent's requests to the loopback port directly, so the attach token counts.

  ```bash
  ssh -N -L 18790:127.0.0.1:18790 you@clawboo-host
  ```

- **A container.** On Linux, a container started with `--network host` connects from the machine's own loopback address, and the token counts. A container on its own network connects from another address, so it needs the access cookie on every request (for Claude Code, `--header "Cookie: clawboo_access=<token>"`), a server that listens beyond loopback, and the host name it uses (such as `host.docker.internal`) in `CLAWBOO_ALLOWED_HOSTS`.
- **Through your reverse proxy.** The proxy's headers make Clawboo refuse the token, so the agent needs the access cookie, and the proxy must pass `/api/mcp/`. If your proxy denies that path, use an SSH tunnel instead.

[Reach Clawboo from another machine](/guides/self-host-securely) covers tunnels, wide binds and proxies.

## The stdio bins

The four bins come with the `clawboo` npm package, which needs Node.js 22.12 or newer. A bin talks over its standard input and output, so it needs no running server and no access token. It opens the database named by `CLAWBOO_DB_PATH`, which by default is a different file from the server's (see [Data and state](/operating/data-and-state)). The stdio snippet sets it for you:

```bash
curl -s 'http://127.0.0.1:18790/api/mcp/config?runtime=claude-code&server=tasks&transport=stdio'
```

For Claude Code the snippet looks like this:

```bash
claude mcp add clawboo-tasks -e CLAWBOO_DB_PATH=/Users/you/.clawboo/clawboo.db -- node /path/to/clawboo/dist/bin/tasks.js
```

With a global npm install the bins are on your `PATH` too, so `clawboo-mcp-tasks` can replace the `node` command.

## Check it works

- **List the tools.** In your agent, list the tools `clawboo-tasks` offers. A signed URL offers 12; an unsigned one offers 6, without the claim and status tools.
- **Same board.** Create a task in the dashboard, then have the agent call `list_tasks`. The task should appear. If it does not appear over stdio, check `CLAWBOO_DB_PATH`.
- **Peer room.** After the agent calls `team_chat_post`, read the peer room with `GET /api/team-chat?teamId=<team-id>`. The post should be there under the agent id you signed. `team_chat_subscribe` never returns an agent's own posts, and it marks teammates' posts `isUser=false` so they read as evidence, not instructions; see [Peer chat](/concepts/peer-chat).

<Accordion title="Talk to a server with curl">

A raw client must send `Accept: application/json, text/event-stream` on every POST, or the server answers `406`. The first request must be `initialize`; its response carries an `mcp-session-id` header that every later request repeats. Replies arrive as server-sent events, on lines that start with `data:`.

```bash
URL='http://127.0.0.1:18790/api/mcp/tasks?attachToken=<token>'

curl -si -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

curl -s -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <session-id>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

This URL carries no scope, so the list has no claim or status tools.

</Accordion>

## Troubleshooting

<AccordionGroup>
<Accordion title="401 Clawboo access token required, on an MCP URL">

**What it means:** the access gate is on, and the request had no cookie and no valid attach token, or it did not come straight to the loopback port.

**Fix:** copy the URL again from `/api/mcp/config` (sending the cookie). A URL from another install, from before a data reset, or from a version without attach tokens has no valid token. Point the agent at `127.0.0.1` directly, not through a proxy. If the agent's environment sets `HTTP_PROXY` or `HTTPS_PROXY`, add `127.0.0.1` and `localhost` to its `NO_PROXY`.

</Accordion>
<Accordion title="406 Not Acceptable">

**What it means:** a POST did not accept both `application/json` and `text/event-stream`.

**Fix:** send `Accept: application/json, text/event-stream`. MCP client libraries do this for you.

</Accordion>
<Accordion title="400 No valid session; send an initialize request first.">

**What it means:** the first request was not `initialize`, or the session id is unknown. Sessions live in the server's memory, so a server restart ends every session.

**Fix:** send `initialize` again, or reconnect the client.

</Accordion>
<Accordion title="400 Invalid or missing MCP session id.">

**What it means:** a GET or DELETE named no live session.

**Fix:** open a session with `initialize` first, and send its `mcp-session-id`.

</Accordion>
<Accordion title="claim_task or update_task_status is missing, or TeamChat lists no tools">

**What it means:** on a team run, this is by design: the team engine claims and moves the run's task itself, so a team run gets no claim or status tools, only `block_task` for its own task. Otherwise the URL is unsigned. TeamChat also stays empty for a URL signed with a team but no agent.

**Fix:** nothing to fix on a team run. Otherwise get the URL from `/api/mcp/config` with `scopeTeamId`, and with `scopeAgentId` for TeamChat. Do not edit the ids in a signed URL.

</Accordion>
<Accordion title="A stdio agent sees an empty board">

**What it means:** the bin opened its default database, not the server's.

**Fix:** set `CLAWBOO_DB_PATH` to the server's `clawboo.db`, or use the stdio snippet, which sets it.

</Accordion>
<Accordion title="400 unknown team, or agent is not on team, from the config call">

**What it means:** `scopeTeamId` names no team, or `scopeAgentId` is a Clawboo agent that belongs to another team.

**Fix:** copy the team's `id` from `GET /api/teams`. For an outside agent, choose an id no Clawboo agent uses; for one of your agents, pass its own team.

</Accordion>
<Accordion title="The config call returns ok but no config">

**What it means:** `runtime` is not `claude-code`, `codex` or `openclaw`.

**Fix:** ask for one of those three formats and take the `url` from `structured`.

</Accordion>
<Accordion title="403 Cross-origin request blocked.">

**What it means:** the request named a host that the same-origin guard does not allow, such as a container's `host.docker.internal`.

**Fix:** add that host name to `CLAWBOO_ALLOWED_HOSTS` and restart the server.

</Accordion>
</AccordionGroup>

<Accordion title="Under the hood">

- Every URL starts with the server's own loopback address and port, never the request's `Host` header, so a forged `Host` cannot point an agent somewhere else.
- Tasks, Memory and Tools URLs carry `scopeTeamId`, `scopeAgentId` and `scopeSig`. TeamChat URLs carry `roomTeamId`, `postAuthorAgentId` and `scopeSig`; for its own orchestrated runs Clawboo adds `delegate=1` inside the signature, which unlocks `team_delegate`. Memory URLs can also carry run details (`provRuntime`, `provTaskId`, `provSessionKey`) signed by `provSig`; they never widen what the agent can read.
- `/api/mcp/config` never writes `scopeTenantId`, and adding one by hand breaks the signature. It checks the team against the `teams` table and an agent id against the `agents` table.
- The signing secret lives in the database (`settings` key `mcp-attach-scope-secret`), so a data reset or a database from another install changes every token and signature, and so does `POST /api/mcp/attach-secret/rotate`.
- The request log masks `attachToken`, `scopeSig` and `provSig`.

</Accordion>

## Related

- [MCP tools reference](/reference/mcp-tools): every tool and its inputs.
- [Tools and MCP API](/reference/rest-api/tools-and-mcp): the request and response shapes for these routes.
- [Security](/operating/security): the access gate, and what to deny at a reverse proxy.
- [Reach Clawboo from another machine](/guides/self-host-securely): tunnels, wide binds, proxies and the access token.
- [Data and state](/operating/data-and-state): the two database paths, and where the signing secret lives.
- [Peer chat](/concepts/peer-chat): how agents use the peer room that TeamChat serves.
