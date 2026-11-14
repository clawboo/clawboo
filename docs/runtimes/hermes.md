---
title: 'Hermes runtime'
sidebarTitle: 'Hermes'
description: 'Run agents on the open-source Hermes agent: Clawboo installs the current release and runs it through Hermes’s own gateway, with each agent as a Hermes profile.'
keywords:
  ['hermes', 'hermes-agent', 'hermes gateway', 'OpenRouter', 'MEMORY.md', 'profiles', 'approvals']
---

Hermes is an open-source agent from Nous Research. Clawboo installs the current Hermes release into its own runtimes folder and runs Hermes's own gateway on this computer, with only its API server on, the way it runs OpenClaw's Gateway. Every Clawboo Hermes agent is a Hermes profile in that gateway: what Hermes saves for it (its `MEMORY.md`, the skills it writes, its sessions, its own scheduled jobs) stays with it from run to run. Use this page to set it up, see which provider it uses, and understand what it can do on your computer.

| Topic           | Hermes                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Best for        | An agent that builds up its own memory and skills over time; many models through one OpenRouter key                                                                           |
| You need        | macOS, Linux or Windows on x64 or arm64, about 450 MB of disk, and one credential: an OpenRouter key, an Anthropic or OpenAI key, or a ChatGPT sign-in. No Python of your own |
| Who bills you   | The provider it runs on (OpenRouter, Anthropic, OpenAI), or your ChatGPT plan                                                                                                 |
| Cost in Clawboo | An estimate, from the tokens Hermes reports (it reports no dollars)                                                                                                           |
| Live output     | Its text and tool calls as they happen                                                                                                                                        |
| Steering        | A comment reaches the running turn after its current tool calls                                                                                                               |
| Approvals       | Hermes asks before the commands its own policy flags; the question is a card in Clawboo                                                                                       |

To compare it with the other runtimes, see [Choose a runtime](/runtimes/index).

## Before you begin

- A computer Hermes has a build for: macOS, Linux (glibc or musl) or Windows, on x64 or arm64.
- Internet access to GitHub for the install.
- One credential:
  - an [OpenRouter](https://openrouter.ai/keys) key, or
  - an Anthropic or OpenAI key you already connected (for Clawboo Native, say), or
  - a ChatGPT plan. The in-app sign-in appears once Codex is connected; see [Codex](/runtimes/codex).

You do not need Python. Hermes 0.23.1 runs only on Python 3.14, and Clawboo installs the exact Python build that release names for itself.

## Set up Hermes

<Steps>

<Step title="Install Hermes">

Open **Settings** (at the bottom of the left sidebar, or press Cmd+, on macOS and Ctrl+, on Windows or Linux), then **Runtimes**. On the **Hermes** row, click **Install**, then **Install** in the panel that opens.

Clawboo installs Hermes 0.23.1 into its runtimes folder (`~/clawboo-runtimes` by default, `CLAWBOO_RUNTIMES_DIR` to choose another), in `hermes/v0.23.1`:

1. It downloads the release's source from GitHub and checks it against the hash Clawboo pins.
2. It downloads the uv and Python 3.14 builds that release pins for itself, each checked against its hash.
3. It checks that this Python runs, then installs Hermes and its dependencies from the release's own lock file, so every package is the version and hash Hermes locked.
4. It checks that the installed Hermes reports version 0.23.1, then makes it the current install.

Clawboo downloads from `github.com` and `objects.githubusercontent.com`, and the dependencies from `pypi.org` and `files.pythonhosted.org`. Behind a proxy, start Clawboo with `HTTPS_PROXY` set to it: the downloads then go through it. When a download cannot get through, the install stops and says so, and nothing changes.

Nothing is piped into a shell, and nothing is installed outside that folder. An update installs beside the current one and switches only once it worked; a failed install leaves the current one as it was.

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

Hermes signs in with a one-time code: the panel shows the code, and you enter it on OpenAI's page. If that page says device authorization is disabled, turn on device code authorization under ChatGPT **Settings** > **Security**, then retry. Hermes keeps this sign-in separate from Codex's and OpenClaw's.

</Tab>

</Tabs>

</Step>

<Step title="Put a Hermes agent on a team">

Create a team, and in **Customize team** set a member's runtime to **Hermes**. You can also pick a model for that member: OpenRouter models when an OpenRouter key is connected, and ChatGPT models when Hermes is signed in with ChatGPT and Codex is connected. **Plan default** in the ChatGPT group lets Hermes use your plan's own default. Leave it on **Default** to let Clawboo choose. Then deploy the team. See [Teams](/using/teams) for the full flow.

</Step>

</Steps>

## The Hermes gateway

Every Hermes agent runs through one Hermes process, its gateway, which Clawboo starts and watches. In **Settings** > **Runtimes**, click **Manage** on the **Hermes** row to see its **Gateway** section: whether it is running, its address, how long it has been up and the Hermes version, with **Restart** (or **Start** when it is not running). When it could not start, the section says why.

- **Only its API server is on.** It listens on `127.0.0.1` only, on port 8642, or the next free port when another program has 8642 (set `CLAWBOO_HERMES_GATEWAY_PORT` to choose). Every request needs a key: Clawboo keeps one key in its encrypted vault and gives the gateway and each agent's profile a key made from it, so no key is stored twice.
- **Hermes's chat channels stay off.** The gateway starts with a short list of environment variables (your locale, proxy and certificate settings), never Clawboo's own environment, so a chat-app token in your shell cannot turn a Hermes channel on. If you turn one on yourself in a profile, one plane owns each chat account: Clawboo or Hermes, never both for the same account.
- **When it runs.** Clawboo starts it at launch when you have Hermes agents (so their own scheduled jobs keep firing), and otherwise when a Hermes agent first works. When it exits on its own, Clawboo starts it again after 1, 2, 5, 10, 30 and then 60 seconds, up to ten times in a row. It stops when Clawboo stops; one that a crash of Clawboo left behind is stopped at the next launch.
- **It is Hermes's own gateway.** Its logs are in `logs/` of its home (see [Agent profiles](#agent-profiles)). Clawboo gives it a lock folder of its own, so a Hermes gateway you run yourself for your own `~/.hermes` is left alone and keeps working beside it.

## What Clawboo controls on Hermes

| What              | On Hermes                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persona           | The agent's `SOUL.md` (which the Personality sliders write into) is added to every prompt as a persona block, up to 4,000 characters.                                                                               |
| `AGENTS.md`       | Draws the agent's links on the team graph. Hermes never reads it.                                                                                                                                                   |
| Other agent files | Not used. Hermes keeps its own `MEMORY.md` in its profile (below), apart from the agent page's file tabs. See [Agents](/using/agents).                                                                              |
| Model             | The model picked for the member in team setup, or one picked later with the model control on the agent's page. Otherwise a default for its provider. See [Which provider Hermes uses](#which-provider-hermes-uses). |
| Hermes profile    | Each agent is a Hermes profile in the gateway, kept between runs (below).                                                                                                                                           |
| Working folder    | Each run's folder: a task's worktree, or the team's folder. Hermes's commands and file tools start there, on this computer.                                                                                         |
| Clawboo tools     | Every run gets Clawboo's Tasks, Memory, Tools and TeamChat servers (MCP), listed in the `mcp_servers` block of the profile's `config.yaml`.                                                                         |
| Leading a team    | A Hermes leader hands work to teammates with the `team_delegate` tool.                                                                                                                                              |
| Worktree          | Only a task-runner run that names a repository gets its own git worktree. Team chat and the tasks a team hands out run in the team's folder. See [Worktrees and handoff](/concepts/worktrees-and-handoff).          |
| Steering          | Live. A comment reaches the running turn after its current tool calls, or before its next model call. See [Board](/using/board).                                                                                    |
| Approvals         | Hermes's own policy decides which commands ask; each question is a card in Clawboo. See [Permissions and safety](#permissions-and-safety).                                                                          |
| Memory            | Hermes's own `MEMORY.md`, skills and sessions in its profile, plus Clawboo's shared memory through the Memory tools.                                                                                                |
| Own jobs          | Jobs the agent schedules in Hermes show in **Routines**, under **Hermes's own jobs**. See [Jobs Hermes runs on its own](#jobs-hermes-runs-on-its-own).                                                              |
| Cost              | An estimate from the tokens Hermes reports. See [Costs](#costs).                                                                                                                                                    |

Hermes has its own task board; Clawboo does not sync it. Hermes works on Clawboo's board through the Tasks tools.

### Which provider Hermes uses

For each run, Clawboo works down this list and uses the first match:

1. **The model picked for the agent** (in team setup, or on the agent's page), if its key or sign-in is available. The run asks for that model's provider (`openrouter` for an OpenRouter model, `openai-codex` for a ChatGPT model). A pick whose key or sign-in is missing is dropped, with its model, and the next rule applies.
2. **A provider named in the agent's Hermes config** (`model.provider` in its `config.yaml`). The run asks for no provider or model, and Hermes uses the config.
3. **An OpenRouter key**: provider `openrouter`, model `openai/gpt-4o-mini`.
4. **An Anthropic key**: provider `anthropic`, model `claude-haiku-4-5`.
5. **An OpenAI key**: provider `openai-api`, model `gpt-4o-mini`.
6. **A ChatGPT sign-in**: provider `openai-codex`, with no model, so Hermes uses your plan's own default.
7. **Nothing**: Hermes uses its own default.

The pick in rule 1 applies when the agent works in its team or in its own chat. A run started over the REST API has no pick; a model named in that request replaces the default models in rules 3 to 5, and is passed in rule 6 too.

Clawboo gives each profile only its OpenRouter, Anthropic and OpenAI keys. If your Hermes config names another provider (Gemini, say), add that provider's key to the profile's `.env` (see [Agent profiles](#agent-profiles)). Clawboo keeps the lines it did not write there; the gateway does not read your shell's environment.

### Agent profiles

The gateway's home is `~/.clawboo/runtimes/hermes/_gateway` (`<agent home>/runtimes/hermes/_gateway` with [agents as their own user](/operating/agent-isolation)), and each agent's profile is `profiles/cb-<agent id>` in it (an id with capital letters gets a hashed name). Everything Hermes saves there is its own and stays between runs. An agent from an earlier Clawboo kept its Hermes home at `~/.clawboo/runtimes/hermes/<agent id>`: the first time it runs through the gateway, that home moves into its profile, with its memory, skills and sessions.

Clawboo writes only these files in a profile:

- `.env`, before each run: the profile's API key, the run's folder (`TERMINAL_CWD`) and the connected OpenRouter, Anthropic and OpenAI keys. Once the run is over, `TERMINAL_CWD` points at the agent's jobs folder, `agents/<agent id>/hermes-jobs` in the [work folder](/operating/data-and-state#the-work-folder), so the jobs Hermes runs on its own work there and not in the last task's folder; a run with no folder of its own works there too. Lines you add with other names are kept. The file is only your user's to read.
- `config.yaml`, copied once from your `~/.hermes/config.yaml` while the profile's copy holds nothing of its own, without its chat channels (`platforms:`, `gateway:` and each channel's own block), so a Clawboo agent never answers your own bots. Clawboo keeps three things in it: one block between `# >>> clawboo mcp_servers` markers that connects Hermes to Clawboo's servers (when your copy has its own `mcp_servers`, Clawboo's go inside it and yours keep working); the `terminal:` keys `cwd` and `backend`, set to `"."` and `local` so commands run in the run's folder on this computer; and the approval settings, set before each run: `approvals.mode` to the mode your own `~/.hermes/config.yaml` chooses, else `manual`, and `approvals.cron_mode` (what a job does with a flagged command, where no one can answer) to your choice, else `deny`. With agents as their own user your file is not read, and the settings are always `manual` and `deny`. A setting an agent writes in its profile lasts only until its next run (see [what this does not protect](#permissions-and-safety)). Clawboo then reads the file the way Hermes does; one that does not read back with these settings (a second `approvals:` key, say) is replaced by a fresh copy of yours, or, with agents as their own user, by a file with only these settings.
- `auth.json`, a copy of your Hermes ChatGPT sign-in, made when the copy there is missing, unusable or older than yours.

Clawboo never writes to your own `~/.hermes`, and refuses to use a profile path that is a link. A profile's `config.yaml` never keeps a chat channel, whatever it came from: an agent's old Hermes home that moves in loses its channels too.

When you delete a Hermes agent while the gateway runs, its jobs in Hermes are paused at once. Either way, its profile is set aside in `profiles-set-aside/` the next time the gateway starts, before Hermes reads it, so its jobs never fire on your keys again. A profile is set aside without its provider keys or its copy of the sign-in, and an agent that comes back gets its profile back, with both written again before its next run. Only one set-aside copy is kept per profile: if a profile is set aside again, the older copy is deleted. A run with no agent profile of its own (a reviewer's run) gets a throwaway `cbtmp-` profile, deleted when the run ends; one left behind is deleted at the first gateway start after Clawboo starts again.

### Your own `~/.hermes`

If you use Hermes yourself, your own Hermes and Clawboo's stay apart. From your `~/.hermes`, Clawboo reads only two files, and copies them into an agent's profile:

With [agents as their own user](/operating/agent-isolation), neither file is copied: your `config.yaml` can hold a provider's key, and your sign-in is yours. Sign in for the agents from the **Hermes** row (that sign-in runs as the agent user, and each profile gets a copy of it), or give Hermes an API key. Your approval settings are not read either: every profile asks before a flagged command (`manual`), and a job refuses one (`deny`).

| From your Hermes                         | In Clawboo's Hermes                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.yaml`                            | Copied once into each new profile (model, provider and the rest, not chat channels); its `approvals.mode` and `approvals.cron_mode` are read before every run |
| `auth.json` (ChatGPT sign-in)            | Copied into each profile when the profile's copy is missing, unusable or older than yours                                                                     |
| `.env` and its keys                      | Not used. Clawboo gives each profile the keys you connected in Clawboo                                                                                        |
| Memory, skills, sessions                 | Not used. Each agent builds its own, in its profile                                                                                                           |
| Your own profiles (`~/.hermes/profiles`) | Not used. Clawboo's profiles live in its gateway's home                                                                                                       |
| Your scheduled jobs                      | Not used. They run in your own Hermes, and are not listed in Clawboo                                                                                          |
| Your own gateway                         | Left running. Clawboo's gateway has its own home, port and lock folder, and runs beside it                                                                    |
| Your own `hermes` program                | Not run. Clawboo runs only the Hermes it installed                                                                                                            |

### Jobs Hermes runs on its own

A Hermes agent can schedule jobs of its own in Hermes. They show in **Routines** in a section of their own, **Hermes's own jobs**, beside OpenClaw's. You can disable, enable, run or delete one there. Through the [Schedules API](/reference/rest-api/schedules) you can also change one's name, schedule or prompt, or add one for an agent that has run at least once. They are the agent's own life, not team work: they run in the agent's own Hermes sessions, not in a team chat, their output stays in Hermes, and Clawboo refuses to schedule team work through Hermes. Use [Routines](/using/routines) for that. Hermes runs a job only while its gateway runs; **Run now** runs it at Hermes's next scheduler tick, within a minute.

## Permissions and safety

<Warning>

Hermes runs as your user account and can read and change any file that account can. Its approvals cover only the commands its own policy flags, such as recursive deletes; everything else, including file edits and network access, runs without asking.

</Warning>

- **Approvals are cards.** When Hermes is about to run a command its policy flags, the run waits and a card appears in **Needs you** on the Board and in the chat: **Run it** or **Don't allow**. Hermes waits 300 seconds by default (`approvals.timeout` in the profile's `config.yaml`), and the card shows the same deadline; then Hermes denies the command and carries on. "Always" is not offered: Hermes would remember it in its own allow list, which no card could show or take back.
- **Hermes's approvals are a check, not a lock.** Clawboo sets `approvals.mode` and `approvals.cron_mode` before each of its runs, and again when the run is over. An agent can get round them, and the card says so:
  - Its commands can read its profile's key, and with it answer its own card through the gateway.
  - Its commands run as your user, so they can edit your own `~/.hermes/config.yaml`, and the settings there are the ones every profile gets at its next run. Only [agents as their own user](/operating/agent-isolation) put your `~/.hermes` out of an agent's reach.
  - The rest of a profile's `config.yaml` is the agent's to edit, with agents as their own user too. Its `command_allowlist` lists commands Hermes runs without asking, and `approvals.timeout` sets how long a card waits.
  - A job Hermes runs on its own can change the profile too, and the jobs after it run with that change until the agent's next Clawboo run.
- **The gateway grants its whole toolset**, the terminal included, to anyone who holds a key. That is why it listens on `127.0.0.1` only, every request needs a key, and the keys stay in the vault and in files only your user can read. Before Clawboo sends the gateway its key, it checks that the program answering on the port is the gateway it started (on Linux, one running as the same user); another program there gets no key, and the start fails saying so. No key appears in a log, a run event or a tool result.
- **Hermes agents can read each other's profiles.** Every profile sits in one gateway home, under your user account (or the one agent user), so one agent's commands can read another agent's profile: its keys, its memory and its MCP URLs. That was so of their separate Hermes homes before too; run agents you do not trust apart from the others.
- **A worktree is not a sandbox.** Only a task-runner run of a task that changes files, with a repository named, works in its own git worktree, which keeps its edits off your main checkout. Everywhere else there is no worktree. A run on a task (one handed out in team chat, one you give from the Board, or a research or review run, which includes every agent Routine you create in the app) starts in the task's own folder, `teams/<team id>/tasks/<task id>` in the [work folder](/operating/data-and-state#the-work-folder) (`~/clawboo-work` by default). Turns that hold no task, such as the lead's turns and your messages in team chat, and the agent's own chat start in its team's folder, `teams/<team id>`, which every member of the team shares (a task or an agent with no team uses `teams/_no-team`). The work folder sits outside Clawboo's data folder, so `../..` from there does not reach the database. Work an install keeps in the data folder (see [The work folder](/operating/data-and-state#the-work-folder) for when that happens) does not get that distance. That folder only sets where it starts: Hermes can still read and change any file your user account can, including Clawboo's database and key vault in `~/.clawboo`, by their full path.
- **Clawboo's approvals do not cover Hermes's own tools.** Calls the agent makes through Clawboo's Tools server (connectors, for example) go through Clawboo's checks and can ask you first.

For work you do not trust, run Clawboo under a separate user account or in a virtual machine. [What agents can do](/concepts/permissions) compares every runtime.

## Costs

Hermes reports each run's input and output tokens, but no dollars. Clawboo prices those tokens at the model's rate when it knows it, and otherwise at $3 per million input and $15 per million output tokens, and counts that estimate toward your budgets.

Your provider bills the real usage: OpenRouter, Anthropic or OpenAI per token, or your ChatGPT plan. See [Budgets and spend](/using/budgets-and-spend).

## Disconnect Hermes

In **Settings** > **Runtimes**, click **Manage** on the **Hermes** row, then **Disconnect**. Hermes stops using its keys until you connect it again, and Clawboo takes them out of every agent's profile. The vault keeps one copy of each key for every runtime, so a key another runtime also reads stays saved: Clawboo Native reads all three Hermes keys (OpenRouter, Anthropic and OpenAI), and Claude Code reads the Anthropic one. The dialog names each saved key and says whether it is deleted or kept. To connect Hermes again with a kept key, click **Use saved key** on its row. A Hermes ChatGPT sign-in is not removed, so Hermes can still read **Connected**.

## Limits

- Hermes cannot ask you a question mid-run: its clarify tool is off for runs through its API server, so it decides for itself or says what it needs in its reply.
- The activity shows each tool call by name and a short preview of it, and whether it failed, but not its output: Hermes's API sends no more.
- A session the agent last ran in another folder is not continued: the run starts a new session, and the task's handoff note carries the continuity.
- An agent's runs go one at a time. A run you stop keeps its agent until Hermes says it has stopped (a command already running finishes first), so the agent's next run waits for it.
- An agent's first run can wait up to about 30 seconds before it starts: Hermes's gateway picks up a new profile on its next scan of the profiles folder.
- Clawboo binds each call Hermes makes to its tools to the agent's run in progress. A job Hermes runs on its own while a Clawboo run of the same agent is in progress is bound to that run too, and works in that run's folder. One that runs between Clawboo's runs is the agent itself, scoped as its own chat is: it can read its team's board and comment, use the agent's own connectors, and make none of a run's other writes, and it works in the agent's jobs folder.
- Hermes runs only while its gateway runs, and so do its own jobs.
- The profile's `config.yaml` is a one-time copy of yours.

## Troubleshooting

<AccordionGroup>

<Accordion title="The Hermes row reads Update needed">

The Hermes Clawboo found is not its own install of the current release: one installed earlier with pip or pipx, for example, which Clawboo no longer runs. Click **Update** on the row, then **Update Hermes**. Your agents' memory and skills move into their profiles on their next run.

</Accordion>

<Accordion title="The install fails with a hash that does not match">

A download did not match the hash Clawboo pins for it, so nothing was installed. A proxy that rewrites downloads, or an incomplete download, does this. Retry; if it keeps failing, check that this computer reaches `github.com` and `objects.githubusercontent.com` directly.

</Accordion>

<Accordion title="Hermes has no build for this computer">

Hermes 0.23.1 has builds for macOS, Linux and Windows on x64 and arm64. Other systems, such as a 32-bit one, cannot run it.

</Accordion>

<Accordion title="The Gateway section reads Not running">

It shows the reason Hermes gave. Port 8642 taken by another program is handled by moving to the next free port; if no port up to 8681 is free, set `CLAWBOO_HERMES_GATEWAY_PORT` to a free one and restart Clawboo. "Another program answers on port" means a program took the port after Clawboo checked it, so the gateway was not sent its key: stop that program, or set `CLAWBOO_HERMES_GATEWAY_PORT`, then click **Start**. For anything else, read `logs/gateway.log` and `logs/errors.log` in the gateway's home, then click **Start**.

</Accordion>

<Accordion title="A Hermes run waits and then carries on without running a command">

Hermes asked before running it and nobody answered within its timeout (300 seconds by default), so it denied the command. Answer the card in **Needs you** while the run waits, or set `approvals.mode` in your own `~/.hermes/config.yaml` to choose what Hermes asks about (Clawboo sets each profile to it before every run, unless agents run as their own user). A job Hermes runs on its own has no one to ask, so it refuses a flagged command outright unless `approvals.cron_mode` there is `approve`.

</Accordion>

<Accordion title="The sign-in page says device authorization is disabled">

Hermes's ChatGPT sign-in uses a one-time code, which some ChatGPT accounts turn off. Turn on device code authorization under ChatGPT **Settings** > **Security**, then retry the sign-in.

</Accordion>

<Accordion title="A Hermes agent says it has no Clawboo tools">

If the profile's config declares `mcp_servers` on one line with servers in it (`mcp_servers: {github: {...}}`), Clawboo cannot add its servers there and logs a warning on each run: write that mapping as indented lines in the profile's `config.yaml`, then click **Restart** in the Gateway section. A profile's MCP servers are connected when the gateway starts, so a change to them takes effect after a restart.

</Accordion>

</AccordionGroup>

## Check that it works

1. In **Settings** > **Runtimes**, the **Hermes** row reads **Connected**, and its Gateway section (under **Manage**) reads **Running** once a Hermes agent has worked.
2. Open the team chat of a team with a Hermes member. Type `@`, pick that agent, and ask: "Say hello in one sentence."
3. You should see the reply stream in under the agent's name. If the run fails, the chat shows "The run failed:" and the reason; look it up in [Troubleshooting](#troubleshooting).

<Accordion title="Under the hood">

- **Install.** The source is `https://github.com/NousResearch/hermes-agent/archive/refs/tags/v0.23.1.tar.gz`, checked against a pinned sha256. Its `pm/lock.json` names the uv build (0.13.5) and the CPython build (3.14.9, from python-build-standalone) with a sha256 for each platform; Clawboo downloads and checks both, then runs `uv sync --frozen --no-dev --extra anthropic --extra mcp --extra sms` in the source tree, with the venv beside it. `anthropic` lets a run use an Anthropic key, `mcp` is the client for Clawboo's servers, and `sms` brings `aiohttp`, which the API server needs (it turns no SMS channel on). Hermes refuses to be built into a package, so it runs from its own tree. An `install-stamp.json` with the tag's commit is how that tree reports version 0.23.1. The release's `tests/` and `website/` folders are removed.
- **Gateway.** `HERMES_HOME=<gateway home> hermes gateway run --external-supervisor -v`, with `HERMES_GATEWAY_LOCK_DIR` set to a folder in its home. Its `config.yaml` turns on one gateway for every profile (`gateway.multiplex_profiles: true`), sets `gateway.api_server.max_concurrent_runs: 10`, and turns off Hermes's update and plugin update checks. Its `.env` holds `API_SERVER_HOST=127.0.0.1`, the port and the key; Hermes turns its API server on when it finds a usable key. Clawboo picks a port free on both `127.0.0.1` and every address, and waits until `GET /health` answers and a keyed call succeeds, since Hermes stays up with no listener when its port or key is refused. Before that keyed call it checks who answers on the port: on macOS the listening process (from `netstat -anv`) must be the gateway or a process it started, and one it cannot trace counts as another program's; on Linux the listener's user (from `/proc/net/tcp` and `/proc/net/tcp6`) must be the gateway's, and on Windows the listening process (from `netstat -ano`) must be the gateway or one it started. When the owner cannot be read, the start goes on and logs it once. A stop sends SIGINT, which Hermes reads as a planned stop; it gives API runs up to 30 seconds to finish. An exit with code 78 (a config Hermes refuses) or 2 (an unreadable config) is not restarted.
- **Runs.** `POST /p/<profile>/v1/runs` with the input (the context block, then the message), a `session_id` (the agent's session to continue, or a new `cb-<uuid>`), and the provider and model from the rules above. The run's events come from `GET /p/<profile>/v1/runs/<run>/events` as server-sent events: `message.delta` is text, `tool.started` and `tool.completed` are tool calls, `approval.request` and `approval.settled` are approvals, and `run.completed` (with the tokens), `run.failed` or `run.cancelled` ends it. When the stream drops, or sends nothing for 60 seconds (not even the keepalive Hermes sends every 10), Clawboo opens it again from the last event, then reads the run's status. A run whose gateway stopped or was replaced ends at once, "The Hermes gateway stopped during the run.", rather than being read from whatever answers on the old port. A failed run's reason is the error Hermes gives; when it holds a provider's error body, its `code` (`invalid_api_key`, `insufficient_quota`, ...) or else its `type` becomes the error's code, so a refused key waits in **Needs you** with **Fix sign-in**, and a run that ended on the model's context window has the code `context_overflow`.
- **Steering and stopping.** A comment is `POST .../v1/runs/<run>/steer`, which Hermes takes only while the run is running; one sent during an approval waits for the next run. An FYI goes only while a tool call is open, so it never buys a turn of its own. Stop is `POST .../v1/runs/<run>/stop`.
- **Approvals.** An answer is `POST .../v1/runs/<run>/approval` with Hermes's `request_id` and `execution_generation`, and `once` or `deny`. A card left open when Clawboo stops expires at the next launch.
- **Clawboo's tools.** Each profile lists Clawboo's four servers with one URL per server that names only the agent (`live=1`, signed with Clawboo's attach secret, so it is good for that agent only). Clawboo binds each call on such a URL to the agent's run in progress: its team, its task, the run's id, and whether the team engine drives it. An agent's runs go one at a time, so there is one run to bind to; with none in progress, the call is bound as the agent's own chat is (the agent, its own team, no task, `chatRun`). The tool list is the widest the agent could need (Hermes keeps it for the life of its connection); a call to a tool the run in progress is not given is refused. Hermes sends no run or session id with these calls, so the binding is by agent. Like every MCP server's tools, Hermes offers Clawboo's through its tool search: the model sees their names and descriptions in the `tool_search` listing and calls them with `tool_call`. The list leaves a one-task tool's `taskId` optional, as it is for any run with a task, so a call that leaves it out acts on the run's own task; the binding also decides the call's team, who it is written as, and which run it is filed under. A run with no identity home (the reviewer's) gets a throwaway profile with its own per-run URLs, removed once Hermes says the run ended.
- **Own jobs.** `GET /p/<profile>/api/jobs?include_disabled=true`, and `POST`, `PATCH`, `DELETE`, `/pause`, `/resume` and `/run` on a job. A job made from Clawboo saves its output in the profile (`deliver: local`).
- Run a board task on Hermes directly with `POST /api/runtimes/hermes/run`, and read or control the gateway with `GET` and `POST /api/runtimes/hermes/gateway`; see the [Runtimes API](/reference/rest-api/runtimes).

</Accordion>

## Related

- [Choose a runtime](/runtimes/index): how Hermes compares with the other runtimes.
- [Connect AI providers and runtimes](/using/providers-and-runtimes): keys, sign-ins and what Disconnect removes.
- [What agents can do](/concepts/permissions): permissions and safety for every runtime.
- [Scheduling](/concepts/scheduling): Routines and the runtimes' own jobs.
- [Budgets and spend](/using/budgets-and-spend): how each runtime's cost reaches your budgets.
- [Memory](/concepts/memory): how Clawboo's shared memory works next to Hermes's own.
