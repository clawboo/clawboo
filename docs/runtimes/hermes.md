---
title: 'Hermes runtime'
sidebarTitle: 'Hermes'
description: 'Run agents on the open-source Hermes agent: install it with Python, connect a key or your ChatGPT plan, and see what it can do on your computer.'
keywords: ['hermes', 'hermes-agent', 'OpenRouter', 'pipx', 'MEMORY.md', 'yolo']
---

Hermes is an open-source agent, published as the `hermes-agent` Python package. Clawboo starts one Hermes process per turn or task, inside a folder that belongs to that agent and stays between runs: `hermes acp`, Hermes's Agent Client Protocol mode, when Hermes has it, and `hermes chat` otherwise. What Hermes saves there (its `MEMORY.md`, the skills it writes, its session history) carries over to the agent's next run. Use this page to set it up, see which provider it uses, and understand what it can do on your computer.

| Topic           | Hermes                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Best for        | An agent that builds up its own memory and skills over time; many models through one OpenRouter key                   |
| You need        | Python 3.11, 3.12 or 3.13, and one credential: an OpenRouter key, an Anthropic or OpenAI key, or a ChatGPT sign-in    |
| Who bills you   | The provider it runs on (OpenRouter, Anthropic, OpenAI), or your ChatGPT plan                                         |
| Cost in Clawboo | An estimate: over ACP from the tokens Hermes reports (it reports no dollars), without ACP from the length of the text |
| Live output     | Its text and tool calls as they happen, with the `acp` extra; otherwise its reply once the run ends                   |
| Steering        | A comment reaches the running turn after its current tool call; without the `acp` extra, it stops and resumes the run |

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

With pipx, Clawboo runs `pipx install --force --python <python> 'hermes-agent[anthropic,acp]<1'`, passing the newest Python from 3.11 to 3.13 it finds. A newer Python on the same machine, such as 3.14, is passed over. If Clawboo finds none in that range, pipx uses its own default Python. Without pipx, Clawboo runs `<python> -m pip install --upgrade --user 'hermes-agent[anthropic,acp]<1'` with that same Python, and retries with `--break-system-packages` on a system that blocks user installs. `--force` and `--upgrade` let the same command update a Hermes that is already installed. The `[anthropic]` extra is what lets Hermes run on an Anthropic key. The `[acp]` extra is Hermes's Agent Client Protocol mode, which lets you watch a run as it works and steer it without stopping it.

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

Create a team, and in **Customize team** set a member's runtime to **Hermes**. You can also pick a model for that member: OpenRouter models when an OpenRouter key is connected, and ChatGPT models when Hermes is signed in with ChatGPT and Codex is connected. The ChatGPT group starts with **Plan default**, then lists the models your plan can run, read from your Codex CLI; Clawboo names none of its own, because OpenAI decides which models each plan may use. **Plan default** passes no model, so Hermes uses your plan's own default. Leave it on **Default** to let Clawboo choose. Then deploy the team. See [Teams](/using/teams) for the full flow.

</Step>

</Steps>

## What Clawboo controls on Hermes

| What              | On Hermes                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persona           | The agent's `SOUL.md` (which the Personality sliders write into) is added to every prompt as a persona block, up to 4,000 characters.                                                                               |
| `AGENTS.md`       | Draws the agent's links on the team graph. Hermes never reads it.                                                                                                                                                   |
| Other agent files | Not used. Hermes keeps its own `MEMORY.md` in its folder (below), apart from the agent page's file tabs. See [Agents](/using/agents).                                                                               |
| Model             | The model picked for the member in team setup, or one picked later with the model control on the agent's page. Otherwise a default for its provider. See [Which provider Hermes uses](#which-provider-hermes-uses). |
| Hermes folder     | Each agent has its own Hermes home that persists between runs (below).                                                                                                                                              |
| Clawboo tools     | Every run gets Clawboo's Tasks, Memory, Tools and TeamChat servers (MCP), listed in the `mcp_servers` block of the folder's `config.yaml`.                                                                          |
| Leading a team    | A Hermes leader hands work to teammates with the `team_delegate` tool.                                                                                                                                              |
| Worktree          | Only a task-runner run that names a repository gets its own git worktree. Team chat and the tasks a team hands out run without one. See [Worktrees and handoff](/concepts/worktrees-and-handoff).                   |
| Steering          | Stop and resume. Hermes cannot read input mid-run, so a comment stops the run and starts it again in the same session with your comment. See [Board](/using/board).                                                 |
| Memory            | Hermes's own `MEMORY.md`, skills and session history in its folder, plus Clawboo's shared memory through the Memory tools.                                                                                          |
| Cost              | Hermes reports none. See [Costs](#costs).                                                                                                                                                                           |

Clawboo starts Hermes only as `hermes chat`, once per turn or task. It never starts Hermes's own gateway or its built-in scheduling; use [Routines](/using/routines) for recurring work.

### Which provider Hermes uses

For each run, Clawboo works down this list and uses the first match:

1. **The model picked for the agent** (in team setup, or on the agent's page), if its key or sign-in is available. Clawboo pins Hermes to that model's provider (`--provider openrouter` for an OpenRouter model, `--provider openai-codex` for a ChatGPT model). A pick whose key or sign-in is missing is dropped, with its model, and the next rule applies.
2. **A provider named in the agent's Hermes config** (`model.provider` in its `config.yaml`). Clawboo passes no provider flag, and Hermes uses the provider and model from the config.
3. **An OpenRouter key**: `--provider openrouter`, model `openai/gpt-4o-mini`.
4. **An Anthropic key**: `--provider anthropic`, model `claude-haiku-4-5`.
5. **An OpenAI key**: `--provider openai-api`, model `gpt-4o-mini`.
6. **A ChatGPT sign-in**: `--provider openai-codex`, with no model, so Hermes uses your plan's own default.
7. **Nothing**: Hermes uses its own default.

The pick in rule 1 applies when the agent works in its team or in its own chat. A run started over the REST API has no pick; a model named in that request replaces the default models in rules 3 to 5, and is passed in rule 6 too.

Clawboo hands Hermes only its OpenRouter, Anthropic and OpenAI keys. If your Hermes config names another provider (Gemini, say), set that provider's key in the environment you start Clawboo from.

### The agent's Hermes folder

Each Hermes agent has its own Hermes home at `~/.clawboo/runtimes/hermes/<agent id>`, created so only your user can open it. Everything Hermes saves there is its own and stays between runs. Clawboo writes only two files there:

- `config.yaml`, copied once from your `~/.hermes/config.yaml` while the folder's copy holds nothing of its own. Clawboo never updates the copy, so later changes to your own config do not reach the agent. Before every run Clawboo rewrites one block in it, between `# >>> clawboo mcp_servers` markers, which connects Hermes to Clawboo's servers. Hermes reads MCP servers only from `mcp_servers` in this file; when your copy has its own `mcp_servers`, Clawboo's servers go inside it and yours keep working.
- `auth.json`, a copy of your Hermes ChatGPT sign-in, made when the copy there is missing, unusable or older than yours.

Clawboo never writes to your own `~/.hermes`, and it does not copy your Hermes `.env`: provider keys reach each run through its environment.

## Permissions and safety

<Warning>

Clawboo runs Hermes with `--yolo`, which approves every Hermes tool call without asking, and `--accept-hooks`, which runs any hooks your Hermes config declares. Nothing asks you before it runs a command, edits or deletes a file, or reaches the network. It runs as your user account and can read and change any file that account can.

</Warning>

- **A worktree is not a sandbox.** Only a task-runner run of a task that changes files, with a repository named, works in its own git worktree, which keeps its edits off your main checkout. Everywhere else there is no worktree: in team chat, in the agent's own chat, and on research and review runs (which includes every agent Routine you create in the app), Hermes starts in its team's folder, `teams/<team id>` in the [work folder](/operating/data-and-state#the-work-folder) (`~/clawboo-work` by default), which every member of the team shares (a task or an agent with no team uses `teams/_no-team`). The work folder sits outside Clawboo's data folder, so `../..` from there does not reach the database. Work an install keeps in the data folder (see [The work folder](/operating/data-and-state#the-work-folder) for when that happens) does not get that distance. That folder only sets where it starts: Hermes can still read and change any file your user account can, including Clawboo's database and key vault in `~/.clawboo`, by their full path.
- **Clawboo's approvals do not cover Hermes's own tools.** Calls the agent makes through Clawboo's Tools server (connectors, for example) go through Clawboo's checks and can ask you first. Hermes's built-in tools never do.
- **Clawboo hides some secrets from it, by name only.** Before a run, Clawboo removes its own secrets and a fixed list of common credentials (GitHub, npm, cloud, Stripe, Slack and database variables) from the environment Hermes inherits. Other variables pass through, and credential files on disk stay readable.

For work you do not trust, run Clawboo under a separate user account or in a virtual machine. [What agents can do](/concepts/permissions) compares every runtime.

## Costs

Hermes reports neither tokens nor dollars to Clawboo. Clawboo estimates each run's cost from the length of the prompt and the reply, at about four characters per token, in team chat, in the agent's own chat, and on runs started over the REST API or by an agent Routine. It prices those tokens at the model's rate when Clawboo knows it, and otherwise at $3 per million input and $15 per million output tokens. That estimate counts toward your budgets.

Your provider bills the real usage: OpenRouter, Anthropic or OpenAI per token, or your ChatGPT plan. See [Budgets and spend](/using/budgets-and-spend) for how each runtime's cost reaches your budgets.

## Disconnect Hermes

In **Settings** > **Runtimes**, click **Manage** on the **Hermes** row, then **Disconnect**. Hermes stops using its keys until you connect it again. The vault keeps one copy of each key for every runtime, so a key another runtime also reads stays saved: Clawboo Native reads all three Hermes keys (OpenRouter, Anthropic and OpenAI), and Claude Code reads the Anthropic one. The dialog names each saved key and says whether it is deleted or kept. To connect Hermes again with a kept key, click **Use saved key** on its row. A Hermes ChatGPT sign-in is not removed, so Hermes can still read **Connected**.

To remove a single key instead, open **Manage**, click that provider's row, and use **Disconnect OpenRouter** (or the button for that provider). That removes the one key for every runtime. See [Disconnect a key or a runtime](/using/providers-and-runtimes#disconnect-a-key-or-a-runtime).

## Limits

- Without the `acp` extra, there is no live text: a Hermes reply appears when its run finishes. The **Hermes** row then reads **Update available**.
- Hermes reports no cost, so Clawboo's figures for it are estimates.
- Without the `acp` extra, a comment stops the run; the tool call in progress at that moment is lost, and finished work is kept.
- The agent's `config.yaml` is a one-time copy of yours.
- Python 3.11 to 3.13 only.

## Troubleshooting

<AccordionGroup>

<Accordion title="Hermes needs Python 3.11 to 3.13, but Clawboo found only Python 3.14">

pipx is not installed, and every Python Clawboo found is outside 3.11 to 3.13. The message lists each version it found, too old or too new, and adds "(Xcode Command Line Tools)" to Apple's own Python on a Mac. Install Python 3.13 (for example `brew install python@3.13`), then click **Retry**.

</Accordion>

<Accordion title="Python 3.11 to 3.13 (with pip or pipx) not found.">

Clawboo found neither pipx nor Python 3. Install Python 3.13 (for example `brew install python@3.13`), then click **Retry**.

</Accordion>

<Accordion title="The install fails with (from versions: none)">

pip found no `hermes-agent` release for the Python it used. That happens when that Python is older than 3.11 or newer than 3.13. Clawboo passes pipx the newest Python from 3.11 to 3.13 it finds; when it finds none, pipx falls back to its own default Python, which can be 3.14. Install Python 3.13, or install Hermes yourself with a supported Python, then click **Refresh** at the top of the Runtimes panel:

```bash
pipx install --python python3.12 'hermes-agent[anthropic,acp]<1'
```

</Accordion>

<Accordion title="Hermes installed, but its row still reads Not installed">

Hermes lands in Python's user folder for programs, which is often missing from the server's search path. Clawboo also looks in the usual user folders, so this is rare. If the install log says "Installed, but 'hermes' isn't on PATH or the known user-install dirs yet. Restart the server if it stays missing.", run `clawboo restart`.

</Accordion>

<Accordion title="the 'anthropic' package is required">

This Hermes was installed without the `[anthropic]` extra, so it cannot run on an Anthropic key. Reinstall it with the extra: `pipx install --force 'hermes-agent[anthropic,acp]<1'` for a pipx install, or `python3 -m pip install --user 'hermes-agent[anthropic,acp]<1'` for a pip install.

</Accordion>

<Accordion title="A Hermes run shows nothing until it finishes">

This Hermes has no ACP mode: it was installed without the `[acp]` extra, before Clawboo asked for it. Clawboo then runs it with `hermes chat`, which prints only at the end, and a comment stops and resumes the run. The line beside **Send** on its running tasks reads "… pauses to read this, then carries on."

In **Settings** > **Runtimes**, the **Hermes** row reads **Update available**. Click **Update** on the row, then **Update Hermes**. Clawboo reinstalls Hermes with the extra, asks it again once the install finishes, and the next run uses ACP. The row reads **Connected** when it worked.

To do it yourself, check with `hermes acp --check`, which says "ACP dependencies not installed" in that case, then reinstall with the extra: `pipx install --force 'hermes-agent[anthropic,acp]<1'`, or `python3 -m pip install --upgrade --user 'hermes-agent[anthropic,acp]<1'` for a pip install. Clawboo asks again within ten minutes, or at once after a restart.

If the row still reads **Update available** after the update, the `hermes` Clawboo runs is not the one that was updated, for example a pip install in a different Python. Run `hermes acp --check` in a terminal, and reinstall the `hermes` it finds.

</Accordion>

<Accordion title="The sign-in page says device authorization is disabled">

Hermes's ChatGPT sign-in uses a one-time code, which some ChatGPT accounts turn off. Turn on device code authorization under ChatGPT **Settings** > **Security**, then retry the sign-in.

</Accordion>

<Accordion title="A Hermes agent says it has no Clawboo tools">

List the MCP servers Hermes sees for that agent:

```bash
HERMES_HOME="${CLAWBOO_HOME:-$HOME/.clawboo}/runtimes/hermes/<agent id>" hermes mcp list
```

Run it in a shell with the same `CLAWBOO_HOME` as the server, or none if the server uses the default.

It should show `clawboo-tasks`, `clawboo-memory`, `clawboo-tools` and `clawboo-teamchat` as enabled after the agent's first run. If your config declares `mcp_servers` on one line with servers in it (`mcp_servers: {github: {...}}`), Clawboo cannot add its servers there and logs a warning on each run: write that mapping as indented lines in the agent's `config.yaml`. Over ACP, Clawboo then declares its servers for each session instead, so the agent still has its tools, but `hermes mcp list` does not show them.

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

- Clawboo sets `HERMES_HOME` to the agent's folder and puts the connected OpenRouter, Anthropic and OpenAI keys in the environment of either kind of run.
- **Over ACP** (the default when Hermes has it), each run is `hermes acp --accept-hooks` with `HERMES_YOLO_MODE=1`, spoken to over stdin and stdout: `initialize`, then `session/load` for a session to resume (a new session if it is gone) or `session/new`, then `session/set_mode` to `dont_ask` and `session/set_model` with `<provider>:<model>` when Clawboo picks the model, then one `session/prompt`. Hermes streams its text, reasoning and tool calls as session updates, and the prompt's answer reports the run's tokens. A comment goes in as `/steer <comment>`, which Hermes adds to the result of the tool call in progress. A comment that arrives while Hermes writes its final answer would be lost there, so Clawboo sends it as one more turn. Stop sends `session/cancel`. Any permission request is answered with allow-once, as `--yolo` does (one that offers no allow-once is cancelled, so Hermes never keeps a standing allow), and file or terminal requests are refused, since Clawboo offers neither.
- Hermes's ACP mode answers a failed turn as a finished one, without its tokens. Clawboo reads a turn that reports no tokens as failed, with the error Hermes logged as the reason.
- On either path, a failed run's reason is what Hermes printed on stderr. On `hermes chat`, a run whose error is also its reply prints it on stdout and leaves only the session line on stderr, so Clawboo also reads the last line of stdout when it is one of Hermes's own failure lines. Anything else on stdout is the model's own words and is never read as the cause: with nothing else to go on, the reason is the exit code. What Hermes logged about an overflow it recovered from is left out, and so are a sub-agent's lines (`[subagent-N]`) and log lines below error level. When the reason holds a provider's error body, the last one counts: its `code` (`invalid_api_key`, `insufficient_quota`, ...) or else its `type` (`authentication_error`, ...) becomes the error's code, so a refused key waits in **Needs you** with **Fix sign-in**; see [Error classes](/reference/events-and-errors#error-classes).
- A run that ended on the model's context window has the code `context_overflow`, as on Claude Code, Codex and Clawboo Native. Hermes compresses a long conversation by itself, so this means it tried and gave up ("Context length exceeded ... Cannot compress further", "Max compression attempts"), or that a provider's error saying so is the last error it printed. Over ACP, it counts only on a turn Hermes answered as finished: a process that dies, or a turn stopped some other way, did not end on an overflow. A rate limit in the same words does not count, and neither does Hermes's "Request payload too large", which is a limit on the size of the request. After such a run, the next run in team chat or a one-to-one chat starts a fresh session instead of resuming that one.
- **Without ACP** (Hermes installed without the `acp` extra), each run is `hermes chat -q <prompt> -Q --yolo --accept-hooks [-m <model>] [--resume <session id>] [--provider <id>] [--continue]`. While it works, Clawboo marks it alive once a minute, for up to two hours, since `-Q` prints nothing until the run ends. When the task runner picks a task back up, Clawboo resumes the saved session with `--resume` (never in a newly created folder). To take a comment, it stops the run and starts it again with `--resume`, or with `--continue` when it does not know the session id yet.
- Clawboo falls back to `hermes chat` on its own when `hermes acp` cannot start or its handshake fails or times out (a run that stalls after the handshake does not fall back), and keeps using it for ten minutes. Reading the runtimes list (the **Runtimes** panel) also asks Hermes with `hermes acp --check`, in a throwaway home it removes afterwards, at most once every ten minutes (a minute when the last check could not tell) and without waiting for the answer. A Hermes without ACP stays on `hermes chat` the same way and its status reports `acpMissing`. An install or update from **Settings** > **Runtimes** forgets both answers and asks again before it reports done. An update keeps going if you close the panel or reload the page, since a reinstall stopped part way can leave Hermes half replaced; while it runs, a second **Update Hermes** says Hermes is already being installed. `CLAWBOO_HERMES_TRANSPORT=quiet` always uses `hermes chat`; `acp` always tries ACP first. A provider picked for the agent without a model also runs on `hermes chat`, since ACP pins a provider only together with a model.
- Over ACP, Hermes offers its editor tool set (terminal, files, web, browser, skills, memory, todo, code and delegation) plus Clawboo's MCP servers; its messaging, scheduling and image tools are left out.
- Hermes has its own task board; Clawboo does not sync it. Hermes works on Clawboo's board through the Tasks tools.
- Run a board task on Hermes directly with `POST /api/runtimes/hermes/run`; see the [Runtimes API](/reference/rest-api/runtimes).

</Accordion>

## Related

- [Choose a runtime](/runtimes/index): how Hermes compares with the other runtimes.
- [Connect AI providers and runtimes](/using/providers-and-runtimes): keys, sign-ins and what Disconnect removes.
- [What agents can do](/concepts/permissions): permissions and safety for every runtime.
- [Budgets and spend](/using/budgets-and-spend): how each runtime's cost reaches your budgets.
- [Memory](/concepts/memory): how Clawboo's shared memory works next to Hermes's own.
