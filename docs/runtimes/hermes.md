---
title: 'Hermes runtime'
sidebarTitle: 'Hermes'
description: 'Run agents on the open-source Hermes agent: install it with Python, connect a key or your ChatGPT plan, and see what it can do on your computer.'
keywords: ['hermes', 'hermes-agent', 'OpenRouter', 'pipx', 'MEMORY.md', 'yolo']
---

Hermes is an open-source agent, published as the `hermes-agent` Python package. Clawboo starts one `hermes chat` per turn or task, inside a folder that belongs to that agent and stays between runs. What Hermes saves there (its `MEMORY.md`, the skills it writes, its session history) carries over to the agent's next run. Use this page to set it up, see which provider it uses, and understand what it can do on your computer.

| Topic           | Hermes                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Best for        | An agent that builds up its own memory and skills over time; many models through one OpenRouter key                |
| You need        | Python 3.11, 3.12 or 3.13, and one credential: an OpenRouter key, an Anthropic or OpenAI key, or a ChatGPT sign-in |
| Who bills you   | The provider it runs on (OpenRouter, Anthropic, OpenAI), or your ChatGPT plan                                      |
| Cost in Clawboo | Hermes reports none; team chat and the agent's own chat record an estimate                                         |
| Steering        | A comment stops the run and resumes it with your comment                                                           |

To compare it with the other runtimes, see [Choose a runtime](/runtimes/index).

## Before you begin

- Python 3.11, 3.12 or 3.13. `hermes-agent` does not install on older or newer versions.
- [pipx](https://pipx.pypa.io) is recommended. Without it, Clawboo installs Hermes with `pip --user`.
- One credential:
  - an [OpenRouter](https://openrouter.ai/keys) key, or
  - an Anthropic or OpenAI key you already connected (for Clawboo Native, say), or
  - a ChatGPT plan. The in-app sign-in appears once Codex is connected; see [Codex](/runtimes/codex).

## Set up Hermes

<Steps>

<Step title="Install Hermes">

Open **Settings** (at the bottom of the left sidebar, or press Cmd+, on macOS and Ctrl+, on Windows or Linux), then **Runtimes**. On the **Hermes** row, click **Install**, then **Install** in the panel that opens.

With pipx, Clawboo runs `pipx install --python <python> 'hermes-agent[anthropic]<1'`, passing the newest Python 3.11 or later it finds. Without pipx, it runs `python -m pip install --user 'hermes-agent[anthropic]<1'`, and retries with `--break-system-packages` on a system that blocks user installs. The `[anthropic]` extra is what lets Hermes run on an Anthropic key.

You should see the row change to **Needs key**, or to **Connected** if a key it can use is already connected.

</Step>

<Step title="Connect a credential">

Pick one way. Each makes the row read **Connected**.

<Tabs>

<Tab title="OpenRouter key">

Click **Connect** on the row, paste your key into the `OPENROUTER_API_KEY` field (**Get a key** opens OpenRouter), and click **Connect**. Clawboo checks the key with OpenRouter before it saves it; if OpenRouter is only unreachable from this computer, click **Connect anyway**.

</Tab>

<Tab title="Anthropic or OpenAI key">

There is nothing more to do. Hermes also reads as connected when an Anthropic or OpenAI key is available, for example the one you connected for Clawboo Native. Its runs then use that provider, as described in [Which provider Hermes uses](#which-provider-hermes-uses).

</Tab>

<Tab title="ChatGPT plan">

With Codex connected, the **Hermes** panel shows "Codex is connected. Hermes can run on your ChatGPT subscription instead of a key." Click **Use my ChatGPT subscription**. On a Hermes that is already connected, open **Manage** and use **Sign in with ChatGPT** on its **ChatGPT subscription** row.

Hermes signs in with a one-time code: the panel shows the code, and you enter it on OpenAI's page. If that page says device authorization is disabled, turn on device code authorization under ChatGPT **Settings** > **Security**, then retry. You can also run `hermes auth add openai-codex` in a terminal, then click **Refresh** at the top of the Runtimes panel.

Hermes keeps this sign-in separate from Codex's and OpenClaw's.

</Tab>

</Tabs>

</Step>

<Step title="Put a Hermes agent on a team">

Create a team, and in **Customize team** set a member's runtime to **Hermes**. You can also pick a model for that member: OpenRouter models when an OpenRouter key is connected, and ChatGPT models when Hermes is signed in with ChatGPT and Codex is connected. Leave it on **Default** to let Clawboo choose. Then deploy the team. See [Teams](/using/teams) for the full flow.

</Step>

</Steps>

## What Clawboo controls on Hermes

| What              | On Hermes                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Persona           | The agent's `SOUL.md` (which the Personality sliders write into) is added to every prompt as a persona block, up to 4,000 characters.                                                                                                |
| `AGENTS.md`       | Draws the agent's links on the team graph. Hermes never reads it.                                                                                                                                                                    |
| Other agent files | Not used. Hermes keeps its own `MEMORY.md` in its folder (below), apart from the agent page's file tabs. See [Agents](/using/agents).                                                                                                |
| Model             | The model picked for the member in team setup, or an OpenRouter model chosen later with the model selector on the agent's page. Otherwise a default for its provider. See [Which provider Hermes uses](#which-provider-hermes-uses). |
| Hermes folder     | Each agent has its own Hermes home that persists between runs (below).                                                                                                                                                               |
| Clawboo tools     | Every run gets Clawboo's Tasks, Memory, Tools and TeamChat servers (MCP), listed in the folder's `mcp.json`.                                                                                                                         |
| Leading a team    | A Hermes leader hands work to teammates with the `team_delegate` tool.                                                                                                                                                               |
| Worktree          | Only a task-runner run that names a repository gets its own git worktree. Team chat and the tasks a team hands out run without one. See [Worktrees and handoff](/concepts/worktrees-and-handoff).                                    |
| Steering          | Stop and resume. Hermes cannot read input mid-run, so a comment stops the run and starts it again in the same session with your comment. See [Board](/using/board).                                                                  |
| Memory            | Hermes's own `MEMORY.md`, skills and session history in its folder, plus Clawboo's shared memory through the Memory tools.                                                                                                           |
| Cost              | Hermes reports none. See [Costs](#costs).                                                                                                                                                                                            |

Clawboo starts Hermes only as `hermes chat`, once per turn or task. It never starts Hermes's own gateway or its built-in scheduling; use [Routines](/using/routines) for recurring work.

### Which provider Hermes uses

For each run, Clawboo works down this list and uses the first match:

1. **The model picked for the agent** (in team setup, or on the agent's page), if its key or sign-in is available. Clawboo pins Hermes to that model's provider (`--provider openrouter` for an OpenRouter model, `--provider openai-codex` for a ChatGPT model). A pick whose key or sign-in is missing is dropped, with its model, and the next rule applies.
2. **A provider named in the agent's Hermes config** (`model.provider` in its `config.yaml`). Clawboo passes no provider flag, and Hermes uses the provider and model from the config.
3. **An OpenRouter key**: `--provider openrouter`, model `openai/gpt-4o-mini`.
4. **An Anthropic key**: `--provider anthropic`, model `claude-haiku-4-5`.
5. **An OpenAI key**: `--provider openai-api`, model `gpt-4o-mini`.
6. **A ChatGPT sign-in**: `--provider openai-codex`, model `gpt-5.5`.
7. **Nothing**: Hermes uses its own default.

The pick in rule 1 applies when the agent works in its team or in its own chat. A run started over the REST API has no pick; a model named in that request replaces the default models in rules 3 to 6.

Clawboo hands Hermes only its OpenRouter, Anthropic and OpenAI keys. If your Hermes config names another provider (Gemini, say), set that provider's key in the environment you start Clawboo from.

### The agent's Hermes folder

Each Hermes agent has its own Hermes home at `~/.clawboo/runtimes/hermes/<agent id>`, created so only your user can open it. Everything Hermes saves there is its own and stays between runs. Clawboo writes only three files there:

- `mcp.json`, refreshed before every run, which connects Hermes to Clawboo's servers.
- `config.yaml`, copied once from your `~/.hermes/config.yaml` when the folder has none. Clawboo never updates the copy, so later changes to your own config do not reach the agent.
- `auth.json`, a copy of your Hermes ChatGPT sign-in, made when the copy there is missing, unusable or older than yours.

Clawboo never writes to your own `~/.hermes`, and it does not copy your Hermes `.env`: provider keys reach each run through its environment.

## Permissions and safety

<Warning>

Clawboo runs Hermes with `--yolo`, which approves every Hermes tool call without asking, and `--accept-hooks`, which runs any hooks your Hermes config declares. Nothing asks you before it runs a command, edits or deletes a file, or reaches the network. It runs as your user account and can read and change any file that account can.

</Warning>

- **A worktree is not a sandbox.** Only a task-runner run of a task that changes files, with a repository named, works in its own git worktree, which keeps its edits off your main checkout. Everywhere else there is no worktree: in team chat, in the agent's own chat, and on research and review runs (which includes every agent Routine you create in the app), Hermes starts in its team's folder, `~/.clawboo/workspaces/<team id>`, which every member of the team shares (a task or an agent with no team uses `workspaces/_no-team`). That folder only sets where it starts: Hermes can still read and change any file your user account can, including Clawboo's database and key vault.
- **Clawboo's approvals do not cover Hermes's own tools.** Calls the agent makes through Clawboo's Tools server (connectors, for example) go through Clawboo's checks and can ask you first. Hermes's built-in tools never do.
- **Clawboo hides some secrets from it, by name only.** Before a run, Clawboo removes its own secrets and a fixed list of common credentials (GitHub, npm, cloud, Stripe, Slack and database variables) from the environment Hermes inherits. Other variables pass through, and credential files on disk stay readable.

For work you do not trust, run Clawboo under a separate user account or in a virtual machine. [What agents can do](/concepts/permissions) compares every runtime.

## Costs

Hermes reports neither tokens nor dollars to Clawboo. In team chat and in the agent's own chat, Clawboo estimates each run's cost from the length of the prompt and the reply, at about four characters per token. It prices those tokens at the model's rate when Clawboo knows it, and otherwise at $3 per million input and $15 per million output tokens. That estimate counts toward your budgets. A run started over the REST API, or by an agent Routine, records no cost at all.

Your provider bills the real usage: OpenRouter, Anthropic or OpenAI per token, or your ChatGPT plan. See [Budgets and spend](/using/budgets-and-spend) for how each runtime's cost reaches your budgets.

## Disconnect Hermes

In **Settings** > **Runtimes**, click **Manage** on the **Hermes** row, then **Disconnect**. The dialog mentions only the OpenRouter key, but Clawboo deletes every key Hermes reads from its vault: OpenRouter, Anthropic and OpenAI. The vault keeps one copy of each key for every runtime. A Clawboo Native team or Claude Code that runs on your Anthropic or OpenAI key therefore loses it too, unless it finds the key elsewhere. A Hermes ChatGPT sign-in is not removed, so Hermes can still read **Connected**.

To remove a single key instead, open **Manage**, click that provider's row, and use **Disconnect OpenRouter** (or the button for that provider). That removes the one key for every runtime. See [Disconnect a key or a runtime](/using/providers-and-runtimes#disconnect-a-key-or-a-runtime).

## Limits

- No live text: a Hermes reply appears when its run finishes.
- Hermes reports no cost, so Clawboo's figures for it are estimates, or nothing outside team chat and the agent's own chat.
- A comment stops the run; the tool call in progress at that moment is lost, and finished work is kept.
- The agent's `config.yaml` is a one-time copy of yours.
- Python 3.11 to 3.13 only.

## Troubleshooting

<AccordionGroup>

<Accordion title="Hermes needs Python 3.11 or newer, but the Python on this machine is 3.9">

The newest Python Clawboo found is too old, and pipx is not installed. The message names your version, and adds "(Xcode Command Line Tools)" on a Mac that only has Apple's Python. Install a newer Python (for example `brew install python@3.12`) or pipx (`brew install pipx`), then click **Retry**.

</Accordion>

<Accordion title="Python 3.11+ (with pip or pipx) not found.">

Clawboo found neither pipx nor Python 3. Install Python 3.12 or pipx, then click **Retry**.

</Accordion>

<Accordion title="The install fails with (from versions: none)">

pip found no `hermes-agent` release for your Python. That happens when the Python it used is older than 3.11 or newer than 3.13. Clawboo picks the newest Python 3.11 or later it finds, so a Python 3.14 wins over a 3.12 you also have. Install Hermes yourself with a supported Python, then click **Refresh** at the top of the Runtimes panel:

```bash
pipx install --python python3.12 'hermes-agent[anthropic]<1'
```

</Accordion>

<Accordion title="Hermes installed, but its row still reads Not installed">

Hermes lands in Python's user folder for programs, which is often missing from the server's search path. Clawboo also looks in the usual user folders, so this is rare. If the install log says "Installed, but 'hermes' isn't on PATH or the known user-install dirs yet. Restart the server if it stays missing.", run `clawboo restart`.

</Accordion>

<Accordion title="the 'anthropic' package is required">

This Hermes was installed without the `[anthropic]` extra, so it cannot run on an Anthropic key. Reinstall it with the extra: `pipx install --force 'hermes-agent[anthropic]<1'` for a pipx install, or `python3 -m pip install --user 'hermes-agent[anthropic]<1'` for a pip install.

</Accordion>

<Accordion title="The sign-in page says device authorization is disabled">

Hermes's ChatGPT sign-in uses a one-time code, which some ChatGPT accounts turn off. Turn on device code authorization under ChatGPT **Settings** > **Security**, then retry the sign-in.

</Accordion>

<Accordion title="My change to ~/.hermes/config.yaml has no effect">

Each agent uses its own copy, made once. Edit `~/.clawboo/runtimes/hermes/<agent id>/config.yaml`, or delete it so the next run copies your current config again.

</Accordion>

</AccordionGroup>

## Check that it works

1. In **Settings** > **Runtimes**, the **Hermes** row reads **Connected**.
2. Open the team chat of a team with a Hermes member. Type `@`, pick that agent, and ask: "Say hello in one sentence."
3. You should see a reply under the agent's name once the run finishes. If the run fails, the chat shows "The run failed:" and the reason; look it up in [Troubleshooting](#troubleshooting).

<Accordion title="Under the hood">

- Each run is `hermes chat -q <prompt> -Q --yolo --accept-hooks [-m <model>] [--resume <session id>] [--provider <id>] [--continue]`. Clawboo sets `HERMES_HOME` to the agent's folder and puts the connected OpenRouter, Anthropic and OpenAI keys in its environment.
- `-Q` prints the reply on stdout and the session id on stderr. When the task runner picks a task back up on Hermes, Clawboo resumes the saved session with `--resume` (never in a newly created folder). To take a comment, it stops the run and starts it again with `--resume`, or with `--continue` when it does not know the session id yet.
- Hermes has its own task board; Clawboo does not sync it. Hermes works on Clawboo's board through the Tasks tools.
- Run a board task on Hermes directly with `POST /api/runtimes/hermes/run`; see the [Runtimes API](/reference/rest-api/runtimes).

</Accordion>

## Related

- [Choose a runtime](/runtimes/index): how Hermes compares with the other runtimes.
- [Connect AI providers and runtimes](/using/providers-and-runtimes): keys, sign-ins and what Disconnect removes.
- [What agents can do](/concepts/permissions): permissions and safety for every runtime.
- [Budgets and spend](/using/budgets-and-spend): how each runtime's cost reaches your budgets.
- [Memory](/concepts/memory): how Clawboo's shared memory works next to Hermes's own.
