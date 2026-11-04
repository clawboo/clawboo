---
title: 'Known issues and limitations'
sidebarTitle: 'Known issues'
description: "What doesn't work yet in Clawboo, or works with a catch: what you see, what it affects, what to do, and whether a fix is waiting for a release."
keywords:
  [
    'known issues',
    'limitations',
    'bugs',
    'workarounds',
    'security advisory',
    'Tokens Used',
    'cost estimate',
    'OTLP',
    'archived team',
  ]
---

This page lists what does not work yet in Clawboo, or works with a catch. Each entry says what you see, what it affects, what to do about it, and its status:

- **Open**: no fix exists yet.
- **Fixed on main**: the fix is in the source code but not in an npm release yet. It ships with the next release.

The latest npm release is 0.5.0. Run `clawboo --version` to see which one you have. For error messages and their fixes, see [Troubleshooting](/help/troubleshooting).

## Security and access

### A reverse proxy on the same machine exposes the MCP servers (0.5.0 and older)

<Warning>

**What you see:** nothing. Behind nginx, Caddy or a Cloudflare Tunnel connector on the same machine, requests to `/api/mcp/` succeed without the access cookie, even with `STUDIO_ACCESS_TOKEN` set.

**What it affects:** a same-host proxy delivers every request from `127.0.0.1`, and these releases let any request from `127.0.0.1` reach every `/api/mcp/` path without the cookie. Anyone who can reach your proxy can use Clawboo's MCP servers (your boards, memory, team chat and tools). They can also ask `/api/mcp/config` for an attach URL signed as any of your agents, with that agent's connector grants.

**What to do:** deny all of `/api/mcp/` at the proxy, not only the four MCP server routes, because `/api/mcp/config` is the one that signs attach URLs. [Security model](/operating/security) has the nginx, Caddy and Cloudflare Tunnel rules. Or upgrade once the next release is out.

**Status:** fixed on main. From the next release, a request without the cookie reaches an MCP server only with an attach token, only on a direct connection to `127.0.0.1`, and never through a proxy. `/api/mcp/config` always needs the cookie.

</Warning>

### An access token with an unsupported character turns the access check off

**What you see:** the dashboard opens without asking for your token, and the server log says `STUDIO_ACCESS_TOKEN contains an unsupported character` and that the access gate is disabled.

**What it affects:** Clawboo accepts only letters, digits, `.`, `_`, `~` and `-` in the token. Any other character switches the token check off. With Clawboo on `127.0.0.1` behind a reverse proxy on the same machine, the dashboard and every `/api/` route are then open to anyone who can reach the proxy. A bind to other machines (`HOST=0.0.0.0`) refuses to start instead.

**What to do:** make a token from the allowed characters, for example with `openssl rand -hex 24`. Restart Clawboo and check that the dashboard asks for the token. See [Reach Clawboo from another machine](/guides/self-host-securely).

**Status:** fixed on main. From the next release, such a token stops the server at startup on every bind, with a `SECURITY: refusing to start` error that names the character. `CLAWBOO_ALLOW_INSECURE=1` does not skip it.

### Keys saved under Providers are also stored unencrypted for OpenClaw

**What you see:** your provider keys appear in plain text in `~/.openclaw/.env`, even if you never installed OpenClaw, and in each OpenClaw agent's `auth-profiles.json`.

**What it affects:** Clawboo copies every key you save on **Settings** > **Providers** into OpenClaw's files so an OpenClaw Gateway can use it. Anything that runs as your user account can read those files, including the coding agents. Deleting `~/.clawboo` removes the encrypted vault but not these copies.

**What to do:** if you do not use OpenClaw, connect keys on the runtime's row in **Settings** > **Runtimes** instead: keys entered there stay in the encrypted vault. To remove a copied key, click **Disconnect** on its row under **Settings** > **Providers**. See [Where keys are stored](/using/providers-and-runtimes#where-keys-are-stored).

**Status:** open. The copy is how the OpenClaw Gateway gets your keys.

### Disconnecting a runtime deletes keys other runtimes use

**What you see:** after you click **Disconnect** on a runtime in **Settings** > **Runtimes**, another runtime can read **Needs key**.

**What it affects:** a runtime's **Disconnect** deletes every key that runtime reads from the vault, and the vault keeps one copy of each key for all runtimes. Disconnecting Hermes, for example, also deletes the Anthropic and OpenAI keys that Clawboo Native or Claude Code run on. The confirmation mentions only one key.

**What to do:** to remove a single key, use **Disconnect** on its row under **Settings** > **Providers**. To undo a runtime's disconnect, connect the keys again. See [Disconnect a key or a runtime](/using/providers-and-runtimes#disconnect-a-key-or-a-runtime).

**Status:** fixed on main. From the next release, a runtime's **Disconnect** keeps any key another runtime also reads and only stops that runtime using it, and its dialog names each saved key it deletes and each one it keeps.

## What agents can reach

### Claude Code, Codex and Hermes run with their own sandboxes off

**What you see:** coding agents run commands, edit and delete files, and reach the network without asking you.

**What it affects:** these runtimes start with their own permission prompts and sandboxes turned off, so they can work unattended. They run as your user account and can read and change any file it can. Without a worktree, as in team chat, in an agent's own chat and in agent Routines you create in the app, they start in their team's folder (`~/.clawboo/workspaces/<team id>`). That folder only sets where they start: they can still reach Clawboo's database and saved keys. A git worktree keeps one task's file changes apart from another's; it is not a sandbox.

**What to do:** give coding agents only work you would let them do unattended. For work you do not fully trust, run Clawboo under a separate user account or in a virtual machine. See [What agents can do](/concepts/permissions).

**Status:** open, by design.

### Claude Code agents follow your own Claude Code settings

**What you see:** a Claude Code agent behaves as if it had your personal Claude Code setup, for example following instructions from your `CLAUDE.md`.

**What it affects:** Clawboo does not limit which settings files Claude Code loads. Every Claude Code agent reads what your own `claude` command reads: your user settings and memory in `~/.claude`, plus any `.claude` settings and `CLAUDE.md` in the folder it works in. All Claude Code agents share them.

**What to do:** keep anything you do not want agents to follow out of `~/.claude`, or run Clawboo under a separate user account. See [Claude Code](/runtimes/claude-code).

**Status:** fixed on main. From the next release, Claude Code agents load only the Claude Code files of the folder they work in, such as a repository's `CLAUDE.md`. Your `~/.claude` settings, plugins, MCP servers and memory files, and Claude Code's auto memory, are left out.

### Clawboo Native shell commands are one approved command at a time

**What you see:** an agent with shell commands turned on asks you before every command, and never offers **Always**.

**What it affects:**

- Each command is one program and its arguments, with no pipes, redirects or chained commands.
- Commands are offered in team chat, one-to-one chat and task runs alike, but never on Windows.
- One run can ask about at most 10 commands. A card waits 10 minutes for your answer, and the run waits with it.
- Once you decline a command, or let a card expire, the agent cannot ask again in that run.

**What to do:** turn shell commands on only for agents that need them, and answer cards promptly. See [What agents can do](/concepts/permissions) and [Approvals](/using/approvals).

**Status:** open, by design.

## Costs and budgets

### Models without a known price are estimated at $3 and $15 per million tokens

**What you see:** a run on a model Clawboo has no price for, such as gpt-5.4 or one of Ollama's cloud models, shows a cost such as `~$0.02 est.` on its task card.

**What it affects:** Clawboo's price table lists Claude models and two GPT-4o models. Any other model is priced at a default rate of $3 per million input tokens and $15 per million output tokens. The run is marked **est.**, and the estimate counts toward your budgets. A model your own Ollama serves is not affected: it is recorded at $0 and reads **free**.

**What to do:** treat **est.** figures as rough. For flat-rate plans, set budgets with the placeholder rate in mind; your provider's bill is the real number.

**Status:** open.

### A hard cap does not stop most runs partway

**What you see:** a budget in **hard cap** mode reads paused at 100%, but a run that was already going keeps working until it finishes, and the budget ends up past its limit.

**What it affects:** only Clawboo Native reports cost while it works, so only a Clawboo Native run can be stopped partway (in team chat and one-to-one chat, only on a model Clawboo prices). Every other run is charged when it finishes. New runs are refused once the budget is paused, on every path.

**What to do:** to end a run that is going, press **Stop** in the chat. See [What a hard cap stops](/concepts/governance#what-a-hard-cap-stops).

**Status:** open.

### A tenant budget never warns or pauses

**What you see:** a tenant budget, made before the Governance form stopped offering **tenant** or through the API, stays at $0 spent.

**What it affects:** nothing charges a tenant budget, so there is no budget for the whole install.

**What to do:** set budgets per team or per agent instead.

**Status:** open.

## Checks on finished work

### Most work is never checked

**What you see:** tasks reach **Done** without a check result.

**What it affects:** Clawboo checks work only for a task-runner run that worked in its own git worktree and changed files. Team chat, Routines created in the app and OpenClaw work are never checked. When a check does run, it uses the verify command in the worktree's `init.sh`. That starts as a placeholder, and a placeholder counts as a failure. On 0.5.0 nothing tells the agent to set it, so the first check fails unless the agent does so on its own. From the next release, the run's instructions and the worktree's `TASK.md` tell it to, and a team can set its own verify command, its [work check](/using/teams#work-check), which every check runs in place of the one in `init.sh`.

**What to do:** review results yourself. For runs that are checked, set the team's [work check](/using/teams#work-check) from the next release on, or name the test command in the task, for example: "Before you finish, set `VERIFY_CMD` in `init.sh` to `npm test`." See [How work is checked](/concepts/verification).

**Status:** open.

## OpenClaw agents

### OpenClaw agents share one memory across teams

**What you see:** a fact an OpenClaw agent saves shows up for OpenClaw agents on other teams.

**What it affects:** OpenClaw agents read and save only global facts, because one Gateway setting serves all of them and Clawboo cannot tell which OpenClaw agent is asking. Agents on other runtimes read their own team's facts and global ones.

**What to do:** for work that needs memory kept per team, use another runtime. See [Memory](/using/memory).

**Status:** open.

### Connectors you share with an OpenClaw agent do not reach it

**What you see:** an OpenClaw agent says it has no tool for a connector you drew to it on the graph, the browser connectors included.

**What it affects:** OpenClaw agents call Clawboo's tools without an agent identity, so connectors shared with a specific agent do not reach them. They can use apps reached through Composio, and every action in those apps asks you first.

**What to do:** give connector work to an agent on another runtime. See [OpenClaw agents and connectors](/using/connectors#openclaw-agents-and-connectors).

**Status:** open.

## Teams and Boo Zero

### Refresh Protocol needs an OpenClaw Gateway, even without OpenClaw agents

**What you see:** **Refresh Protocol** on a team reports **Not connected to Gateway**.

**What it affects:** it runs only while the dashboard is connected to an OpenClaw Gateway, even for teams with no OpenClaw members.

**What to do:** connect a Gateway, or edit each agent's AGENTS.md on its page. See [Teams](/using/teams).

**Status:** open.

## Memory and observability

### Memory similarity search looks for Ollama on this computer only

**What you see:** with Ollama on another machine and `OLLAMA_BASE_URL` pointing at it, your agents chat on that Ollama, but Memory does not use it for similarity search.

**What it affects:** Memory always looks for Ollama at `http://localhost:11434` and ignores `OLLAMA_BASE_URL`. Without an Ollama there, Memory uses an OpenAI key if you connected one, which sends fact text to OpenAI, or keyword search only.

**What to do:** run Ollama with the `nomic-embed-text` model on the computer that runs Clawboo. See [Turn on similarity search](/using/memory#turn-on-similarity-search).

**Status:** open.

### OpenTelemetry export does nothing on an npm install

**What you see:** with `OTEL_EXPORTER_OTLP_ENDPOINT` set, no traces reach your collector. **System Health** shows the **OTel exporter** check as **Degraded**, saying the install does not include the OpenTelemetry SDK, and its observability line reads "local event log (OTLP endpoint set, exporter not running)".

**What it affects:** the npm package does not include the OpenTelemetry SDK, so the exporter cannot load. Traces stay in Clawboo's own event log, where the Observability panel shows them.

**What to do:** if you need export, run Clawboo from a source checkout of the repository, which installs the SDK. See [Observability](/concepts/observability).

**Status:** open.

## Setup and platform

### Runtime requirements that catch people out

| Runtime     | Limit                                                                                                                                                                                                       | What to do                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Needs an Anthropic API key: a `claude` CLI signed in with a Claude subscription is not enough. On an npm install it also needs the Claude Agent SDK next to Clawboo, which a one-off `npx` run cannot load. | Run `npm install -g clawboo @anthropic-ai/claude-agent-sdk`, then `clawboo restart`. See [Claude Code](/runtimes/claude-code). |
| Codex       | Connects only with **Sign in with ChatGPT**, never an API key. A Codex too old to have `codex app-server` runs without live steering: a comment waits for its next run.                                     | Update Codex with `npm install -g @openai/codex@0`. See [Codex](/runtimes/codex).                                              |
| Hermes      | Installs only on Python 3.11 to 3.13. The in-app install picks the newest Python in that range. If it finds none, pipx uses its own default Python, which can be 3.14, and the install fails.               | Install Python 3.13 and click **Retry**, or install it yourself with a supported Python. See [Hermes](/runtimes/hermes).       |
| OpenClaw    | On Windows, the dashboard cannot run OpenClaw's own **Sign in with ChatGPT**.                                                                                                                               | Run the command the setup panel shows in your own terminal. See [OpenClaw](/runtimes/openclaw).                                |

### The full Marketplace needs an internet connection

**What you see:** the Marketplace shows only 5 teams and 15 agents.

**What it affects:** Clawboo's server downloads the full catalog published with its version from the Clawboo repository on GitHub, and refreshes it at most every 6 hours. Offline, or until the download lands, you see only the built-in pack.

**What to do:** check that the computer running Clawboo can reach GitHub, then wait for the next refresh. On a machine that cannot reach GitHub, serve the catalog files from a mirror and point `CLAWBOO_CATALOG_INDEX_URL` at it. See [Marketplace](/using/marketplace).

**Status:** open, by design.

## Self-hosting

### Binding to one network address cuts agents off from Clawboo's tools

**What you see:** with `HOST` set to the computer's own network address, other machines reach the dashboard, but agents lose their Clawboo tools, such as the board and memory.

**What it affects:** Clawboo's agents and background jobs connect to `127.0.0.1`, and a bind to one address does not listen there.

**What to do:** use `HOST=0.0.0.0` with an access token, `CLAWBOO_ALLOWED_HOSTS` and `CLAWBOO_ALLOWED_ORIGINS`, or keep the default and reach Clawboo through an SSH tunnel or a reverse proxy. See [Reach Clawboo from another machine](/guides/self-host-securely).

**Status:** open.

### The clawboo command cannot manage a server that uses an access token

**What you see:** `clawboo`, `clawboo stop` or `clawboo restart` prints `A Clawboo server is running on port 18790, but it requires an access token.` and exits.

**What it affects:** the launcher cannot check a token-protected server, so it will not start a second one, stop it or restart it. `clawboo stop` and `clawboo restart` print a command to stop the server by hand. Starting a new server with `STUDIO_ACCESS_TOKEN` set also confuses it: after about 45 seconds it prints `Dashboard is taking too long to start.` and exits, while the server keeps running.

**What to do:** stop and start that server the way you started it, for example with `Ctrl+C` in its terminal or through your service manager. To open a server you just started, visit `http://localhost:18790/?access_token=<token>` (use your port if it is not 18790). See [Run the Clawboo server](/operating/deployment) and [CLI reference](/reference/cli).

**Status:** fixed on main. From the next release, the command uses the `STUDIO_ACCESS_TOKEN` set in the shell you run it from. With the server's token there, `clawboo` sees a server it just started and opens it, and `clawboo stop` and `clawboo restart` work. Without it, they print the same notice as before.

### One install serves one person

**What you see:** everyone who can open the dashboard sees every team, agent, task and memory fact.

**What it affects:** Clawboo has no user accounts and keeps no data apart per person. Anyone with the access token gets the whole install.

**What to do:** run one install per person, each under its own user account on the computer or in its own virtual machine. Separate data folders (`CLAWBOO_HOME`) under one account do not keep people apart: they share `~/.openclaw` and its saved keys, and coding agents can read any file that account can. See [Data and state](/operating/data-and-state).

**Status:** open, by design.

### Live event streams have no limit

**What you see:** nothing in normal use.

**What it affects:** each open live event stream (`GET /api/obs/stream`) keeps polling the database until its client disconnects, and nothing limits how many can be open. This matters only when many clients can reach the server.

**What to do:** behind a reverse proxy, limit concurrent connections there, and keep the access token on. See the [Observability API](/reference/rest-api/observability).

**Status:** open.

## Issues in 0.5.0 that are fixed on main

These problems affect the 0.5.0 release. They are fixed on main and ship with the next release, which the [changelog](/appendices/changelog) describes under **Unreleased**.

| What you see on 0.5.0                                                                                                                                                                                 | Area        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Requests to `/api/mcp/` through a reverse proxy on the same machine skip the access token (see the [first entry on this page](#security-and-access))                                                  | Security    |
| A `STUDIO_ACCESS_TOKEN` with an unsupported character turns the access check off (see [the entry above](#an-access-token-with-an-unsupported-character-turns-the-access-check-off))                   | Security    |
| Clawboo writes `~/.openclaw/.env`, OpenClaw agents' `auth-profiles.json`, `settings.json` and `clawboo backup` files with your default permissions                                                    | Security    |
| Over HTTP, a TeamChat MCP session with no signed identity can read and post in any team's [peer chat](/concepts/peer-chat) as any agent, and `create_subtask` can file work under another team's task | Security    |
| Claude Code agents load your own `~/.claude` settings, plugins, MCP servers and memory (see [the entry above](#claude-code-agents-follow-your-own-claude-code-settings))                              | Security    |
| A remembered **Always** on a connector tool skips the prompt even under access set to ask every time (`approvalPolicy: always`)                                                                       | Security    |
| An `allow_always` answer to a risky hand-off, sent through the API, stops that leader's risky hand-offs from asking again, with no end date                                                           | Security    |
| `/api/mcp/config` signs any team id, and replacing the attach secret means editing the database by hand                                                                                               | Security    |
| A saved key with no recognized prefix (Groq, Mistral, xAI) is stored in clear in tool-call records, events, memory, run summaries and the verify gate's output                                        | Security    |
| Picking **Ollama** during setup records nothing: a new team runs on Anthropic, and its first message says Clawboo Native has no provider key                                                          | Ollama      |
| Setup accepts an Ollama with no model pulled, then every run fails with "model not found"                                                                                                             | Ollama      |
| Agents run on Anthropic when an `ANTHROPIC_API_KEY` is in your shell or in `~/.openclaw/.env`, even after you picked another default provider                                                         | Providers   |
| **Set up OpenClaw** asks for an Anthropic, OpenAI or OpenRouter key even when Ollama is your provider                                                                                                 | OpenClaw    |
| After you change OpenClaw's Gateway port, **Set up OpenClaw** still points Clawboo at port 18789                                                                                                      | OpenClaw    |
| Without an OpenClaw Gateway, **Create Boo** is missing, the graph's **New agent** fails with `gateway_disconnected`, and deleting agents does not work                                                | Agents      |
| An OpenClaw agent deleted while the Gateway is down comes back on the next connect                                                                                                                    | OpenClaw    |
| Approving this device during OpenClaw setup can stick on "Approved. Reconnecting…" with only **Cancel**                                                                                               | OpenClaw    |
| The Gateway will not start after an OpenClaw upgrade until you run `openclaw doctor --fix`                                                                                                            | OpenClaw    |
| A second update from the dashboard's update chip fails with "exit code 7"                                                                                                                             | Updates     |
| After an update from the chip, the server runs without the node options it was started with, such as `--max-old-space-size`                                                                           | Updates     |
| The update chip offers **Click to update** on an install the server's user cannot write, such as a container image, and nothing turns it off                                                          | Updates     |
| Every install reads the Marketplace catalog from the `main` branch, including content written for newer versions                                                                                      | Marketplace |
| Playwright and Chrome DevTools start through `npx` on every new install with no way to turn that off, each beside a resident `npm exec`, and Chrome DevTools sends usage statistics                   | Connectors  |
| The API answers "Too many requests" after a run of page loads                                                                                                                                         | Server      |
| Two instances under different path prefixes on one hostname share browser storage: a new one skips its welcome screen, and theme, layout and board choices carry over                                 | Server      |
| With "reduce motion" turned on, the Radial layout of the Org chart (called Atlas in 0.5.0) piles each team's Boos on top of each other                                                                | Org chart   |
| With the sidebar hidden, a Boo elsewhere on the page can draw only its eyes and paws                                                                                                                  | Display     |
| The in-app Hermes install picks Python 3.14 over an installed 3.12, and fails                                                                                                                         | Hermes      |
| Picking a model on a Hermes agent's page moves an agent on the ChatGPT subscription to OpenRouter                                                                                                     | Hermes      |
| On a ChatGPT-only setup, a Marketplace deploy starts its members on Clawboo Native, which has no provider there, and pressing **Deploy** again after "No agents could be created" fails               | Teams       |
| The reviewer's run on checked work is not charged to any budget and is missing from **Tokens Used**                                                                                                   | Budgets     |
| `POST /api/team-chat/exchange` cancels every exchange at its first turn                                                                                                                               | Team chat   |
| Hermes agents get none of Clawboo's tools: they cannot claim tasks, post in team chat, use memory or call connectors                                                                                  | Hermes      |
| A delegated Hermes task that works for more than eight minutes is stopped as unresponsive                                                                                                             | Hermes      |
| A Claude Code run that hits an API error (a bad key, an expired sign-in, a billing limit) lands its task as done, with the error text as its result                                                   | Claude Code |
| New Google agents on Clawboo Native start on `gemini-2.0-flash`, which Google shut down                                                                                                               | Providers   |
| Connecting OpenClaw with a Google key sets `google/gemini-2.0-flash`, which Google shut down and OpenClaw now rejects                                                                                 | OpenClaw    |
| A review that failed or returned nothing is shown as **Reviewed by**                                                                                                                                  | Checks      |
| A runtime's **Disconnect** deletes keys other runtimes use, and its dialog names only one (see [the entry above](#disconnecting-a-runtime-deletes-keys-other-runtimes-use))                           | Providers   |
| On OpenClaw 2026.9, **Create Boo** and Marketplace deploys of OpenClaw agents fail partway, because Clawboo wrote a TOOLS.md that Gateway refuses                                                     | OpenClaw    |
| Saving SOUL.md while custom personality instructions are on writes the slider personality over them                                                                                                   | Agents      |
| Deleting an agent leaves its routines behind, and each one fails with `agent ... not found`                                                                                                           | Routines    |
| Removing a route on the Org chart does nothing without an OpenClaw Gateway, and the empty Org chart says to connect one                                                                               | Org chart   |
| **System Health** reads degraded on an install that never set up OpenClaw, and says "OTel exporter active" when nothing is exported                                                                   | Health      |
| Connecting a connector, even from an agent's request for it, gives no agent access unless you draw it on the graph                                                                                    | Connectors  |
| The default browser access can only read pages, because Playwright marks navigate and click as destructive                                                                                            | Connectors  |
| "Do not ask again for this for 30 days" on a connector call never stops the next prompt                                                                                                               | Connectors  |
| Agents are offered a `web_search` tool that only repeats the query (once `TAVILY_API_KEY` is set) and a `delete_path` tool that deletes nothing                                                       | Tools       |
| Archived teams cannot be restored from the dashboard, and an agent cannot move to another team                                                                                                        | Teams       |
| Boo Zero's **Global Brief** is saved but never sent to Boo Zero                                                                                                                                       | Boo Zero    |
| Claude Code reads **Not installed** with only the Claude Agent SDK installed, though runs use the SDK's own binary, and **Install** downloads a second copy of that binary                            | Runtimes    |
| Routines run in the server process's time zone, which in a container is UTC unless `TZ` is set, so a 9:00 routine runs at 9:00 UTC                                                                    | Routines    |
| Connectors and approved shell commands lose npm's prefix, cache and update-check settings, so an approved `npm install -g` can fail with `EACCES`                                                     | Connectors  |

## Related

- [Troubleshooting](/help/troubleshooting): error messages and their fixes.
- [Changelog](/appendices/changelog): what each release changed, and what is waiting for the next one.
- [What agents can do](/concepts/permissions): what each runtime can reach on your computer.
- [Budgets and spend](/using/budgets-and-spend): where spend shows and which costs are estimates.
- [Security model](/operating/security): what protects an install, and the proxy rules for 0.5.0.
