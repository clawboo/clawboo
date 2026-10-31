---
title: 'OpenClaw'
sidebarTitle: 'OpenClaw'
description: 'Run OpenClaw agents in Clawboo: set up the OpenClaw Gateway from the dashboard, approve this device, and see what Clawboo writes, runs and costs.'
keywords:
  [
    'openclaw',
    'openclaw gateway',
    'gateway',
    'quickstart openclaw',
    'set up openclaw',
    'device pairing',
    'NOT_PAIRED',
    'connected substrate',
    'auto-configure',
    'TOOLS.md',
  ]
---

[OpenClaw](https://docs.openclaw.ai) is a separate agent platform. Its agents live in a long-running server called the **OpenClaw Gateway**, where they keep their own workspaces, messaging channels and cron jobs. Clawboo connects to a Gateway on your computer, shows its agents next to your others, and runs them in team chat, on the board and in Routines.

- **Best for:** people who already use OpenClaw, or who want agents that also answer on OpenClaw's messaging channels (set up in OpenClaw itself).
- **You need:** a Node.js version that OpenClaw supports, and a credential it can use: a provider key, a ChatGPT sign-in or a local Ollama. Clawboo installs and starts the Gateway for you.

## Before you begin

- **Node.js in OpenClaw's range:** the setup installs the newest 2026.9 release of OpenClaw. Since 2026.9.34 that release needs 24.22.1 or later in the 24 line, or 26.12.1 and later (`>=24.22.1 <25 || >=26.12.1`). Node 22 and Node 25 can no longer run it, even though Clawboo itself runs on Node 22.12 and later. The setup doesn't check, so run `node --version` first. See OpenClaw's [Node.js guide](https://docs.openclaw.ai/install/node).
- **`npm` on your `PATH`.** The setup installs OpenClaw with `npm install -g openclaw@~2026.9`.
- **A credential OpenClaw can reuse:** a provider key you connected in Clawboo, a ChatGPT sign-in, or the local Ollama you set up for [Clawboo Native](/runtimes/native). With none of these, the setup asks you for a key.

You don't need OpenClaw installed already. If it is, the setup keeps your install, fills in only the settings that are missing, and uses a Gateway that is already running.

## Set up OpenClaw

**Set up OpenClaw** is one button. It reuses a credential you already connected, installs OpenClaw if needed, starts the Gateway and connects to it. The same setup runs from **Settings > Runtimes** and from onboarding's **Add more runtimes** step.

<Steps>
<Step title="Start the setup">

Open **Settings > Runtimes**. On the **OpenClaw** row ("Run OpenClaw agents on a local Gateway"), click **Set up**, then **Set up OpenClaw**. In onboarding, the **Add more runtimes** step has the same row.

The row's footer reads **In setup**, and the panel shows **Preparing OpenClaw…**.

</Step>
<Step title="Let Clawboo reuse a credential">

Clawboo looks for a credential in this order and uses the first one it finds:

1. **A provider key saved in Clawboo** (on the **Providers** page, in onboarding or on a runtime's card) or already in OpenClaw's `~/.openclaw/.env`. A key that is only exported in your shell doesn't count. With several keys, it takes the first in this order: Anthropic, OpenAI, Google, OpenRouter, xAI, Groq, Mistral, Moonshot, MiniMax, Together, NVIDIA, Hugging Face, Cerebras, Venice.
2. **A ChatGPT sign-in that OpenClaw already holds.**
3. **A ChatGPT sign-in that only Codex holds.** The panel asks you to sign OpenClaw in too (next step).
4. **The local Ollama you set up for Clawboo Native.**
5. **Nothing.** The panel asks you for a key (next step).

It then writes OpenClaw's configuration. It sets the Gateway to local mode and otherwise fills in only what is missing, so your default model and other settings stay. See [What Clawboo writes to OpenClaw](#what-clawboo-writes-to-openclaw).

</Step>
<Step title="Add a key or sign in, if asked">

**Nothing connected.** The panel reads "Connect a provider key for OpenClaw to use. It powers the local Gateway." Pick **Anthropic**, **OpenAI** or **OpenRouter**, paste the key and click **Connect & set up** (or press Enter). Clawboo saves the key the way the **Providers** page does, then runs the setup again.

**Codex is signed in, OpenClaw isn't.** Each runtime keeps its own ChatGPT sign-in, so OpenClaw needs one too. The panel installs OpenClaw first if it is missing, then shows **Sign in with ChatGPT**. Click it: your browser opens on OpenAI's sign-in page, with no code to type, and the setup carries on once the sign-in is saved. **Re-check** runs the setup again, and **Use an API key instead** switches to the key prompt. On Windows, the panel gives you the command to run in your own terminal instead.

**Ollama doesn't have the model.** If your Ollama is missing OpenClaw's default model, or isn't running, the setup stops before it starts the Gateway. The panel names the model it couldn't find and shows the `ollama pull` command for it. Run that command, then click **Check again**. **Continue anyway** starts the Gateway regardless, but OpenClaw agents can't answer until the model is there.

</Step>
<Step title="Install OpenClaw and start the Gateway">

If OpenClaw isn't installed, the panel shows **Installing OpenClaw…** and runs `npm install -g openclaw@~2026.9`, with npm's output in a log. Then it shows **Starting the Gateway…**. A Gateway that is already running on OpenClaw's port is used as it is. Otherwise Clawboo starts one and waits up to 60 seconds for it to answer.

If OpenClaw asks for `openclaw doctor --fix` before it will start (this can happen after an OpenClaw upgrade), Clawboo runs it once and starts the Gateway again.

The log fills with install and Gateway lines, then the panel moves on to connecting.

</Step>
<Step title="Approve this device">

OpenClaw asks you to approve each new device once before it can connect, so the panel shows an **Approve this device** card. Click **Approve this device**. The card reads "Approved. Reconnecting…" and connects again.

You should see **OpenClaw connected**. The panel closes about a second later, and the OpenClaw row reads **Connected**.

</Step>
</Steps>

![Set up OpenClaw on onboarding's Add more runtimes step: the install log streams while the Gateway starts](/images/openclaw-inline-setup.png)

### If a step fails

The panel replaces its progress with the error and a **Retry** button. **Retry** runs the whole setup again: it skips the install once OpenClaw is installed, and joins a Gateway that is still starting instead of launching a second one.

If the reconnect after approval fails, or OpenClaw still says the device isn't approved, the error reads "OpenClaw still needs this device approved. Retry to approve it again." **Retry** then brings back a fresh approval card.

**Cancel** closes the panel at any point before it connects. An install that has already started still finishes in the background. The exact errors and their fixes are under [Troubleshooting](#troubleshooting).

### Approve from a terminal instead

The approval card runs two OpenClaw commands for you. You can run them yourself:

```bash
openclaw devices approve --latest
openclaw devices approve <requestId>
```

The first prints the id of the waiting request; the second approves it. Then run **Set up OpenClaw** or **Reconnect OpenClaw** again so Clawboo connects. See OpenClaw's [devices command](https://docs.openclaw.ai/cli/devices).

### Use your ChatGPT plan

OpenClaw can run on a ChatGPT subscription instead of an API key, through its own `openai-codex` provider. It needs its own sign-in, separate from Codex's:

- During setup, or later under **Manage > ChatGPT subscription**, click **Sign in with ChatGPT**. This needs Codex connected first; until then the row reads "Connect Codex first".
- Or run OpenClaw's own login in a terminal: `openclaw models auth login --provider openai-codex`. Use it rather than `openclaw onboard`, which can reset your channels, memory and cron jobs.

With the sign-in in place, the setup writes no key, and sets OpenClaw's default model to `openai-codex/gpt-5.5` if none is set. OpenClaw agents, Codex agents, Hermes on a ChatGPT sign-in and your own Codex use all share your plan's limits.

## Default models

When OpenClaw has no default model yet, the setup picks one for the provider it reused. It never replaces a default you already have.

| Provider        | Default model                                                    |
| --------------- | ---------------------------------------------------------------- |
| Anthropic       | `anthropic/claude-sonnet-4-5`                                    |
| OpenAI          | `openai/gpt-5.4`                                                 |
| Google          | `google/gemini-2.0-flash`                                        |
| OpenRouter      | `openrouter/anthropic/claude-sonnet-4-5`                         |
| xAI             | `xai/grok-3`                                                     |
| Groq            | `groq/llama-3.3-70b-versatile`                                   |
| Mistral         | `mistral/mistral-large-latest`                                   |
| Moonshot        | `moonshot/kimi-k2.5`                                             |
| MiniMax         | `minimax/MiniMax-M2.5`                                           |
| Together        | `together/meta-llama/Llama-3.3-70B-Instruct-Turbo`               |
| NVIDIA          | `nvidia/llama-3.1-nemotron-70b-instruct`                         |
| Hugging Face    | `huggingface/deepseek-ai/DeepSeek-R1`                            |
| Cerebras        | `cerebras/zai-glm-4.7`                                           |
| Venice          | `venice/llama-3.3-70b`                                           |
| Local Ollama    | `ollama/` plus a model your Ollama has pulled (`llama3.2` first) |
| ChatGPT sign-in | `openai-codex/gpt-5.5`                                           |

Change it under **Manage > Default model**, which every OpenClaw agent uses unless it has its own model. An agent's own model is set on its page. For OpenClaw's model settings, see [Model providers](https://docs.openclaw.ai/concepts/model-providers) and, for Ollama, [Ollama](https://docs.openclaw.ai/providers/ollama).

## What a new Boo is allowed to run

OpenClaw's Gateway decides whether an OpenClaw agent may run a command, from each agent's command policy. Clawboo sets that policy when it creates an agent:

- **A new OpenClaw agent gets Ask for Unknown.** It asks you before running a command it hasn't been allowed. (A caller of the REST API can pass another posture, and Clawboo writes that one instead.)
- **A refused policy stops the creation.** If the Gateway won't take the policy, Clawboo removes the half-made agent and **Create Boo** shows "Could not set this agent's command permissions on the Gateway, so it was not created", followed by the reason.
- **An agent made outside Clawboo** has no policy from Clawboo. It follows the Gateway's own defaults, which let it run commands without asking unless you changed them.
- **Nothing re-applies a posture later.** Clawboo writes it when it creates the agent, and when you change **Command Execution** on the agent's **Permissions** tab. A change made outside Clawboo stays.

Answering **Always** to a command card adds a standing permission. The agent's **Permissions** tab lists those under **Commands this Boo can run without asking**, where you can revoke one. See [Command permissions](/using/command-permissions) and OpenClaw's [exec approvals](https://docs.openclaw.ai/tools/exec-approvals).

## Manage OpenClaw

Once OpenClaw is connected, its row reads **Connected** and offers **Manage**:

| In **Manage**            | What it does                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Gateway**              | Shows **Running** or **Stopped**, the port and the uptime, with **Restart** (or **Start** if it stopped) |
| **LLM providers**        | Lists the keys saved on the **Providers** page, each with its own **Disconnect**                         |
| **ChatGPT subscription** | OpenClaw's own ChatGPT sign-in: **Sign in with ChatGPT**, "Connect Codex first", or **Connected**        |
| **Default model**        | The model every OpenClaw agent uses unless it has its own                                                |
| **MCP attach config**    | The snippet for attaching Clawboo's MCP servers by hand; see [MCP servers](/operating/mcp-servers)       |
| **Re-check**             | Checks the connection again                                                                              |
| **Disconnect**           | Stops the local Gateway ("Stop the OpenClaw gateway?"). OpenClaw agents go offline until it starts again |
| **Details**              | A read-only diagnostics view                                                                             |

When OpenClaw is set up but its Gateway is offline, the row shows that and offers **Reconnect**. **Reconnect OpenClaw** runs the same setup as above: it reuses your configuration and starts the Gateway. For OpenClaw's own service commands, see [the gateway command](https://docs.openclaw.ai/cli/gateway).

## What Clawboo writes to OpenClaw

Clawboo changes OpenClaw's files in these places. `~/.openclaw` is OpenClaw's state folder (`OPENCLAW_STATE_DIR` moves it), and `~/.clawboo` is Clawboo's (`CLAWBOO_HOME` moves it).

| Where                                                 | What Clawboo writes                                                                                                                                                                                                                                                  | When                                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `~/.openclaw/.env`                                    | A Gateway token (`GATEWAY_AUTH_TOKEN`) when there is none yet; the provider key it reused, under its usual name such as `ANTHROPIC_API_KEY`; `OLLAMA_API_KEY=ollama-local` for Ollama, a marker rather than a secret                                                 | **Set up OpenClaw**, and every key you save on the **Providers** page                                                        |
| `~/.openclaw/agents/<agent>/agent/auth-profiles.json` | The same provider key, for each OpenClaw agent that exists                                                                                                                                                                                                           | Same as above                                                                                                                |
| `~/.openclaw/openclaw.json`                           | Local Gateway mode (`gateway.mode: local`). Only where missing: port 18789, token authentication, a default model, and agent-to-agent messaging. With `OLLAMA_BASE_URL` set, an Ollama provider entry that points at it, because OpenClaw doesn't read that variable | **Set up OpenClaw**                                                                                                          |
| `openclaw.json`, through the Gateway                  | Clawboo's MCP servers, and `sessions_spawn` and `sessions_yield` on the denied tools list (see [Clawboo tools inside OpenClaw](#clawboo-tools-inside-openclaw))                                                                                                      | Each time the server connects, skipped when nothing changed                                                                  |
| `openclaw.json`                                       | The default model (with its context window, when Clawboo knows it), an agent's own model, and the default command approval for all agents                                                                                                                            | When you change **Default model** in **Manage**, an OpenClaw agent's model, or **Command Approval** in **Settings > System** |
| The Gateway's command policies                        | Each agent's **Command Execution** posture                                                                                                                                                                                                                           | When Clawboo creates an agent, and when you change its posture                                                               |
| The agent's workspace, `~/.openclaw/workspace-<name>` | `SOUL.md`, `IDENTITY.md`, `TOOLS.md` and `AGENTS.md` (see [Agent files](#agent-files))                                                                                                                                                                               | When Clawboo creates the agent, and when you edit a file                                                                     |
| `~/.clawboo/settings.json`                            | The Gateway address, with the port from `openclaw.json`, and the Gateway token                                                                                                                                                                                       | **Set up OpenClaw**, and when Clawboo reads a new token from `.env`                                                          |

<Warning>

Provider keys in `~/.openclaw/.env` and in each agent's `auth-profiles.json` are stored in plain text, because that is where OpenClaw reads them. Anyone who can read those files can read the keys. Clawboo's own copy stays in its encrypted vault.

</Warning>

To back up or reset these folders, see [Where Clawboo keeps data](/operating/data-and-state). For OpenClaw's own settings, see its [configuration guide](https://docs.openclaw.ai/gateway/configuration).

## How Clawboo talks to the Gateway

Clawboo keeps two connections to the Gateway. Both use a device identity that you approved once during setup, stored in `~/.clawboo/proxy-device-identity.json`. That identity only proves Clawboo to the Gateway; it does not protect the dashboard itself (see [Self-host securely](/guides/self-host-securely)).

**The server's own connection** stays open whenever the Gateway runs, with or without a browser tab. Over it, Clawboo:

- runs every OpenClaw agent turn in team chat, including the tasks those agents are given;
- runs OpenClaw agent Routines, and lists the Gateway's own cron jobs on the Routines page, where you can turn them on or off, run them or delete them;
- keeps its copy of your OpenClaw agents up to date, so they still show when the Gateway is down;
- receives command approval requests, so they wait in Clawboo's approvals even with no tab open;
- records activity and token use from OpenClaw sessions, including ones Clawboo didn't start, such as a channel message or one of an agent's own cron jobs;
- registers its MCP servers in the Gateway's configuration, and passes your comments into running tasks.

**The browser's connection** goes through the Clawboo server, which adds the saved Gateway token, so the server never sends that token to the browser. It carries your 1:1 chats with an OpenClaw agent and streams replies as they arrive.

**When the Gateway is down**, your OpenClaw agents still show (from Clawboo's last copy) but can't run. You can't create an OpenClaw agent or edit its files: **Create Boo** makes a Clawboo Native agent instead, and says so. Deleting an OpenClaw agent is remembered and sent to the Gateway when it reconnects. If you also have agents on other runtimes, the dashboard loads as usual with a banner, "OpenClaw Gateway is offline", and a **Reconnect** button.

For the protocol detail, see [Gateway and events](/internals/gateway-and-events).

## Clawboo tools inside OpenClaw

Each time the server connects, Clawboo registers three of its MCP servers in the Gateway's configuration, so every OpenClaw agent can use them. One Gateway configuration serves every OpenClaw agent, so Clawboo can't tell which agent is calling, and each server is limited accordingly:

| Server | What OpenClaw agents can do                     | The limit on OpenClaw                                                                                                                                        |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Memory | Read and save shared [memory](/concepts/memory) | Global memory only: no team's memory, and nothing saved to one team                                                                                          |
| Tasks  | Create, update, block and link board tasks      | Can't claim or assign a task                                                                                                                                 |
| Tools  | Use apps reached through Composio               | Connectors you give an agent on the graph don't reach it, and every Composio action asks you first ([why](/using/connectors#openclaw-agents-and-connectors)) |

TeamChat isn't registered. OpenClaw agents take part in team chat through Clawboo, which posts each of their turns under the right name. Clawboo also adds `sessions_spawn` and `sessions_yield` to OpenClaw's denied tools, so agents hand work to their team instead of spawning sub-agents of their own. An OpenClaw leader hands work on by calling OpenClaw's `sessions_send` tool, or with a `<delegate to="@Name">…</delegate>` block in its reply; Clawboo turns either one into a board task.

## Agent files

An OpenClaw agent's files live in its workspace on the Gateway. Clawboo writes them when it creates the agent, and when you edit them on the agent's page (**Details**, then the file tabs). Editing needs the Gateway running.

| File          | What it is for                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOUL.md`     | Persona, tone and boundaries. OpenClaw loads it every session.                                                                                                                                                                                  |
| `AGENTS.md`   | Operating instructions, loaded every session. For a team's agents, Clawboo writes the team roster and how to work with the team here. It also adds web-browsing instructions to every OpenClaw agent. Put tool notes in its `## Tools` section. |
| `IDENTITY.md` | The agent's name, vibe and emoji.                                                                                                                                                                                                               |
| `TOOLS.md`    | Clawboo still shows this tab, but OpenClaw 2026.9 and later doesn't load it. Move its content into `AGENTS.md`; OpenClaw's `openclaw doctor --fix` merges an existing `TOOLS.md` there for you.                                                 |

Clawboo neither creates nor reads `HEARTBEAT.md`, `USER.md` or `MEMORY.md`; the file editor shows them only when they already have content. To schedule an OpenClaw agent's own work, use OpenClaw's [cron jobs](https://docs.openclaw.ai/automation/cron-jobs) or a Clawboo [Routine](/using/routines). OpenClaw's [agent workspace guide](https://docs.openclaw.ai/concepts/agent-workspace) covers every file.

## Comments on a running task

A comment you leave on a task an OpenClaw agent is working on joins its running turn at the next step, without stopping a tool that is running. If the run can't take it, the comment waits for the agent's next run. See [Steering a running task](/runtimes/index#steering-a-running-task).

## Costs

OpenClaw's Gateway reports no cost to Clawboo, so every OpenClaw figure you see is Clawboo's estimate:

- **Budgets** are charged an estimate for each OpenClaw turn in team chat, and for each OpenClaw Routine run that succeeds (a failed or timed-out run records nothing). It is worked out from the length of the prompt and the reply, at about four characters per token.
- **Tokens Used** shows the token counts OpenClaw records for each turn, priced from Clawboo's rate table.
- **A 1:1 chat** with an OpenClaw agent shows in **Tokens Used**, but is not charged to budgets.

On a ChatGPT plan you pay a flat fee, so these figures are a budget guide, not your bill. Budgets only warn you unless you set a hard cap. See [Budgets and spend](/using/budgets-and-spend).

## Limits

- **No worktree, no checks.** OpenClaw agents work in their own Gateway workspace. Clawboo never gives them a git worktree and never runs verification on their work; see [How work is checked](/concepts/verification).
- **Global memory, no connectors from the graph.** See [Clawboo tools inside OpenClaw](#clawboo-tools-inside-openclaw).
- **A Gateway on this computer.** **Set up OpenClaw** configures and starts a local Gateway. Clawboo registers its MCP servers at a `127.0.0.1` address, which a Gateway on another machine can't reach.
- **Routine runs stop after 10 minutes.** An OpenClaw Routine run that hasn't finished by then is stopped. `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS` changes the limit.
- **The 2026.9 line.** Clawboo installs `openclaw@~2026.9`, because it writes OpenClaw's configuration in that line's format.
- **Not on the runtimes API.** `/api/runtimes/openclaw/...` answers `404`. OpenClaw is managed through the [System API](/reference/rest-api/system).

## Troubleshooting

<AccordionGroup>
<Accordion title="NOT_PAIRED: pairing required, device is not approved yet">

**What it means:** OpenClaw hasn't approved this device yet. Every connect is refused until you approve it once.

**Fix:** click **Approve this device** on the card the setup shows. If you approve from a terminal instead (see [Approve from a terminal instead](#approve-from-a-terminal-instead)), run **Set up OpenClaw** or **Reconnect OpenClaw** again afterwards to connect.

</Accordion>
<Accordion title="OpenClaw still needs this device approved. Retry to approve it again.">

**What it means:** the approval went through, but the reconnect after it failed, or OpenClaw still reported the device as unapproved.

**Fix:** click **Retry**. The setup runs again and shows a fresh approval card if the device still needs one.

</Accordion>
<Accordion title="The approval card shows an error">

The card shows what the approval step reported:

- `No pending device pairing requests found`: OpenClaw had no request waiting, for example because the device is already approved. Close the panel with **Cancel** and run **Set up OpenClaw** again; it connects, or shows a fresh card.
- `OpenClaw not installed`: Clawboo can't find the `openclaw` command. Run the setup again, or check that npm's global folder is on your `PATH`.
- `Failed to approve device: …` or `Failed to run openclaw: …`: the OpenClaw command failed. Run the two terminal commands above to see OpenClaw's own message.

</Accordion>
<Accordion title="Permission denied. Your Node.js installation may require sudo for global installs.">

**What it means:** npm can't write to its global folder. The message suggests `sudo npm install -g openclaw@~2026.9`.

**Fix:** prefer a Node.js version manager (nvm or fnm) or Homebrew's Node, which install global packages without `sudo`. Then click **Retry**.

</Accordion>
<Accordion title="Installation failed with exit code">

**What it means:** `npm install -g openclaw@~2026.9` failed. A Node.js version outside OpenClaw's range is a common cause.

**Fix:** run `node --version` and compare it with [Before you begin](#before-you-begin). Install a supported Node.js, then click **Retry**.

</Accordion>
<Accordion title="Gateway did not start, or did not become reachable within 60s">

**What it means:** the Gateway exited with a reason (`Gateway did not start: …`), or never answered on its port within 60 seconds.

**Fix:** read the Gateway's log at `~/.clawboo/gateway.log`, fix what it reports, then click **Retry**. OpenClaw's [troubleshooting guide](https://docs.openclaw.ai/help/troubleshooting) and [doctor command](https://docs.openclaw.ai/gateway/doctor) help with OpenClaw's own errors.

</Accordion>
<Accordion title="OpenClaw needs openclaw doctor --fix, and running it failed">

**What it means:** OpenClaw asked for a data migration before it would start, and the `openclaw doctor --fix` that Clawboo ran failed.

**Fix:** run `openclaw doctor --fix` in a terminal to see the whole report, then start the Gateway again with **Retry** or **Reconnect OpenClaw**. Do the same if the message says OpenClaw still asks for `openclaw doctor --fix` after Clawboo ran it.

</Accordion>
<Accordion title="Clawboo couldn't find the model in your Ollama">

**What it means:** OpenClaw's default model isn't pulled in your Ollama, or Ollama isn't running.

**Fix:** start Ollama, run the `ollama pull` command the panel shows, then click **Check again**.

</Accordion>
<Accordion title="OpenClaw Gateway is offline, or unreachable">

**What it means:** the Gateway stopped or can't be reached. Your OpenClaw agents are paused; agents on other runtimes keep working.

**Fix:** click **Reconnect** on the banner, or **Reconnect OpenClaw** in **Settings > Runtimes**. If the Gateway rejected Clawboo's token, the banner offers **Restart Gateway** instead, because the Gateway reads its token only when it starts.

</Accordion>
<Accordion title="Could not set this agent's command permissions on the Gateway, so it was not created">

**What it means:** the Gateway refused the command policy for a new agent, so Clawboo removed the agent rather than leave it unguarded. The reason follows the message.

**Fix:** check that the Gateway is running and connected (**Manage > Re-check**), then create the agent again.

</Accordion>
<Accordion title="The API answers 503 gateway_disconnected">

**What it means:** the request needs the Gateway (creating an OpenClaw agent, reading or writing its files), and Clawboo's server isn't connected to it.

**Fix:** start the Gateway from **Settings > Runtimes > OpenClaw**, then try again.

</Accordion>
</AccordionGroup>

## Check it works

<Steps>
<Step title="Check the runtime">

Open **Settings > Runtimes**. **OpenClaw** reads **Connected**, and under **Manage** the **Gateway** reads **Running**.

</Step>
<Step title="Talk to an OpenClaw agent">

Open an OpenClaw agent from the agent column and send a short message in its chat. With no OpenClaw agent yet, **Create Boo** makes one while the Gateway is connected. You should see a reply stream in.

</Step>
<Step title="Put OpenClaw agents on a team">

Deploy a team from the **Marketplace**. While the Gateway is connected, a marketplace team's members default to OpenClaw; change any member in **Customize team**. In onboarding, members default to Clawboo Native instead, or to Codex if you signed in with ChatGPT.

</Step>
</Steps>

<Accordion title="Under the hood">

- **The connections.** The browser connects to `/api/gateway/ws` on the Clawboo server, which adds the token and signs the device before passing it on. The server's own connection is an operator client (client id `cli`) that sends the Gateway host as its Origin and declares the `tool-events` and `exec-approvals` capabilities. Clawboo supports Gateway connect protocols 3 and 4.
- **Write budget.** The Gateway allows three configuration writes per 60 seconds, so the MCP registration skips its write when nothing has changed.
- **`configure-openclaw`.** The dashboard never calls `POST /api/system/configure-openclaw`. It writes a fresh `openclaw.json` and `.env`, replacing what is there, and makes a new Gateway token on every call, so use it only on a fresh OpenClaw. **Set up OpenClaw** uses `POST /api/system/auto-configure-openclaw`, which fills in only what is missing. See the [System API](/reference/rest-api/system).
- **Model refs.** Clawboo writes the ChatGPT model as `openai-codex/<model>`. `openclaw doctor --fix` later rewrites it to `openai/<model>` and turns on the plugins that form needs.
- **The pin.** `openclaw@~2026.9` holds OpenClaw's configuration format (the agent roster under `agents.entries`, and stricter `config.patch` rules), not the connect protocol.
- **More detail:** [Gateway and events](/internals/gateway-and-events) and [Agent sources](/internals/agent-source).

</Accordion>

## Related

- [Choose a runtime](/runtimes/index): how OpenClaw compares with the other runtimes
- [Connect providers and runtimes](/using/providers-and-runtimes): keys, sign-ins and what Disconnect removes
- [Command permissions](/using/command-permissions): review and revoke what an OpenClaw agent may run
- [Where Clawboo keeps data](/operating/data-and-state): back up or reset `~/.clawboo` and `~/.openclaw`
- [OpenClaw docs](https://docs.openclaw.ai): install, channels, cron jobs and troubleshooting for OpenClaw itself
